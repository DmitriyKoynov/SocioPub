import { beforeEach, describe, expect, it } from 'vitest';
import {
  executeReliableSubmission,
  SUBMISSION_CONCURRENCY,
  SUBMISSION_MAX_ATTEMPTS
} from './submissionOrchestrator';
import { configureFakeApiFaults, fakeApiService, resetFakeApiState } from './fakeApi';

it('exports the configured concurrency and attempts', () => {
  expect(SUBMISSION_CONCURRENCY).toBe(20);
  expect(SUBMISSION_MAX_ATTEMPTS).toBe(10);
});

describe('executeReliableSubmission', () => {
  const sessionId = 'fake-session-test';
  const date = '2026-05-06';

  beforeEach(() => {
    resetFakeApiState();
  });

  it('runs multiple visit creates for one cell concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const api = {
      ...fakeApiService,
      createServiceVisit: async (
        params: Parameters<typeof fakeApiService.createServiceVisit>[0]
      ) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        try {
          return await fakeApiService.createServiceVisit(params);
        } finally {
          inFlight -= 1;
        }
      }
    };

    const result = await executeReliableSubmission({
      api,
      sessionId,
      date,
      changes: [
        {
          serviceName: 'Услуга 1',
          clientId: 'C1',
          clientName: 'Клиент 1',
          serviceId: 'S1',
          originalCount: 0,
          targetCount: 5
        }
      ],
      concurrency: 10
    });

    expect(result.operations[0].status).toBe('verifiedSuccess');
    expect(await fakeApiService.getServiceVisitCount('C1', 'S1', sessionId)).toBe(5);
    expect(peak).toBeGreaterThan(1);
  });

  it('handles large volume and verifies final counts', async () => {
    const changes = Array.from({ length: 150 }, (_, index) => {
      const clientIndex = Math.floor(index / 10);
      const serviceIndex = (index % 10) + 1;
      return {
        serviceName: `Услуга ${serviceIndex}`,
        clientId: `C${clientIndex + 1}`,
        clientName: `Клиент ${clientIndex + 1}`,
        serviceId: `S${serviceIndex}`,
        originalCount: 0,
        targetCount: 1
      };
    });

    const result = await executeReliableSubmission({
      api: fakeApiService,
      sessionId,
      date,
      changes,
      concurrency: 6
    });

    expect(result.failed).toBe(0);
    expect(result.operations).toHaveLength(150);
    expect(result.operations.every((op) => op.status === 'verifiedSuccess')).toBe(true);

    const sampleCount = await fakeApiService.getServiceVisitCount('C1', 'S1', sessionId);
    expect(sampleCount).toBe(1);
  });

  it('prevents over-apply when server applied but responded false', async () => {
    configureFakeApiFaults({ createFalseNegativeRate: 1 });

    const changes = [
      {
        serviceName: 'Услуга 1',
        clientId: 'C1',
        clientName: 'Клиент 1',
        serviceId: 'S1',
        originalCount: 0,
        targetCount: 1
      }
    ];

    const statuses: string[] = [];
    const result = await executeReliableSubmission({
      api: fakeApiService,
      sessionId,
      date,
      changes,
      maxRetries: 2,
      onOperationUpdate: (_index, patch) => {
        if (patch.status) {
          statuses.push(patch.status);
        }
      }
    });

    const finalCount = await fakeApiService.getServiceVisitCount('C1', 'S1', sessionId);
    expect(finalCount).toBe(1);
    expect(result.operations[0].status).toBe('verifiedSuccess');
    expect(statuses.includes('responseReceived') || statuses.includes('unknown')).toBe(true);
  });

  it('does not overshoot a 0→5 cell when every create returns false', async () => {
    configureFakeApiFaults({ createFalseNegativeRate: 1, latencyMs: 40 });

    const result = await executeReliableSubmission({
      api: fakeApiService,
      sessionId,
      date,
      changes: [
        {
          serviceName: 'Услуга 1',
          clientId: 'C1',
          clientName: 'Клиент 1',
          serviceId: 'S1',
          originalCount: 0,
          targetCount: 5
        }
      ]
    });

    expect(await fakeApiService.getServiceVisitCount('C1', 'S1', sessionId)).toBe(5);
    expect(result.operations[0].status).toBe('verifiedSuccess');
  });

  it(
    'finishes create units when the observed count has crossed the target',
    async () => {
      let readCount = 0;
      const overTargetIds = Array.from({ length: 6 }, (_, index) => `V${index + 1}`);
      const api = {
        ...fakeApiService,
        getVisitIds: async () => {
          readCount += 1;
          return readCount === 1 ? [] : overTargetIds;
        },
        createServiceVisit: async () => {
          throw new Error('createServiceVisit must not be called after crossing the target');
        }
      };

      const result = await executeReliableSubmission({
        api,
        sessionId,
        date,
        changes: [
          {
            serviceName: 'Услуга 1',
            clientId: 'C1',
            clientName: 'Клиент 1',
            serviceId: 'S1',
            originalCount: 0,
            targetCount: 5
          }
        ]
      });

      expect(result.operations[0].status).toBe('verifiedMismatch');
      expect(result.operations[0].observedCount).toBe(6);
      expect(result.failed).toBe(1);
    },
    1_000
  );

  it(
    'finishes delete units when the observed count has crossed the target',
    async () => {
      let readCount = 0;
      const api = {
        ...fakeApiService,
        getVisitIds: async () => {
          readCount += 1;
          return readCount === 1 ? ['V1', 'V2', 'V3'] : [];
        },
        deleteServiceVisit: async () => {
          throw new Error('deleteServiceVisit must not be called after crossing the target');
        }
      };

      const result = await executeReliableSubmission({
        api,
        sessionId,
        date,
        changes: [
          {
            serviceName: 'Услуга 1',
            clientId: 'C1',
            clientName: 'Клиент 1',
            serviceId: 'S1',
            originalCount: 3,
            targetCount: 1
          }
        ]
      });

      expect(result.operations[0].status).toBe('verifiedMismatch');
      expect(result.operations[0].observedCount).toBe(0);
      expect(result.failed).toBe(1);
    },
    1_000
  );

  it('treats five visits in one cell and one in another as one shared queue', async () => {
    const result = await executeReliableSubmission({
      api: fakeApiService,
      sessionId,
      date,
      changes: [
        {
          serviceName: 'Услуга 1',
          clientId: 'C1',
          clientName: 'Клиент 1',
          serviceId: 'S1',
          originalCount: 0,
          targetCount: 5
        },
        {
          serviceName: 'Услуга 2',
          clientId: 'C2',
          clientName: 'Клиент 2',
          serviceId: 'S2',
          originalCount: 0,
          targetCount: 1
        }
      ]
    });

    expect(result.failed).toBe(0);
    expect(result.operations.every((op) => op.status === 'verifiedSuccess')).toBe(true);
    expect(await fakeApiService.getServiceVisitCount('C1', 'S1', sessionId)).toBe(5);
    expect(await fakeApiService.getServiceVisitCount('C2', 'S2', sessionId)).toBe(1);
  });

  it('deletes down to the exact target count', async () => {
    for (let i = 0; i < 3; i += 1) {
      await fakeApiService.createServiceVisit({
        clientId: 'C1',
        serviceId: 'S1',
        sessionId,
        date,
        hours: 0,
        minutes: 30
      });
    }

    const result = await executeReliableSubmission({
      api: fakeApiService,
      sessionId,
      date,
      changes: [
        {
          serviceName: 'Услуга 1',
          clientId: 'C1',
          clientName: 'Клиент 1',
          serviceId: 'S1',
          originalCount: 3,
          targetCount: 1
        }
      ]
    });

    expect(result.operations[0].status).toBe('verifiedSuccess');
    expect(await fakeApiService.getServiceVisitCount('C1', 'S1', sessionId)).toBe(1);
  });

  it('retries only the failing visit unit and leaves other cells successful', async () => {
    configureFakeApiFaults({ hardFailCreateKeys: ['C1_S1'] });
    let c1Creates = 0;
    let c2VerifiedBeforeC1Finished = false;
    const api = {
      ...fakeApiService,
      createServiceVisit: async (
        params: Parameters<typeof fakeApiService.createServiceVisit>[0]
      ) => {
        if (params.clientId === 'C1' && params.serviceId === 'S1') {
          c1Creates += 1;
        }
        return fakeApiService.createServiceVisit(params);
      }
    };

    const result = await executeReliableSubmission({
      api,
      sessionId,
      date,
      changes: [
        {
          serviceName: 'Услуга 1',
          clientId: 'C1',
          clientName: 'Клиент 1',
          serviceId: 'S1',
          originalCount: 0,
          targetCount: 1
        },
        {
          serviceName: 'Услуга 2',
          clientId: 'C2',
          clientName: 'Клиент 2',
          serviceId: 'S2',
          originalCount: 0,
          targetCount: 1
        }
      ],
      onOperationUpdate: (index, patch) => {
        if (index === 1 && patch.status === 'verifiedSuccess') {
          c2VerifiedBeforeC1Finished = c1Creates < SUBMISSION_MAX_ATTEMPTS;
        }
      }
    });

    expect(c1Creates).toBe(SUBMISSION_MAX_ATTEMPTS);
    expect(c2VerifiedBeforeC1Finished).toBe(true);
    expect(result.operations[0].status).toBe('verifiedMismatch');
    expect(result.operations[1].status).toBe('verifiedSuccess');
    expect(await fakeApiService.getServiceVisitCount('C1', 'S1', sessionId)).toBe(0);
    expect(await fakeApiService.getServiceVisitCount('C2', 'S2', sessionId)).toBe(1);
  }, 20000);

  it('respects the configured limit of in-flight visit mutations', async () => {
    configureFakeApiFaults({ latencyMs: 30 });
    let inFlight = 0;
    let peak = 0;
    const api = {
      ...fakeApiService,
      createServiceVisit: async (
        params: Parameters<typeof fakeApiService.createServiceVisit>[0]
      ) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          return await fakeApiService.createServiceVisit(params);
        } finally {
          inFlight -= 1;
        }
      }
    };

    const changes = Array.from({ length: SUBMISSION_CONCURRENCY + 2 }, (_, index) => ({
      serviceName: `Услуга ${index + 1}`,
      clientId: `C${index + 1}`,
      clientName: `Клиент ${index + 1}`,
      serviceId: `S${index + 1}`,
      originalCount: 0,
      targetCount: 1
    }));

    const result = await executeReliableSubmission({
      api,
      sessionId,
      date,
      changes
    });

    expect(result.operations.every((op) => op.status === 'verifiedSuccess')).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(SUBMISSION_CONCURRENCY);
  });
});

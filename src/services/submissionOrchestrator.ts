import type { ApiService } from './apiContract';

export type SubmissionOperationStatus =
  | 'pending'
  | 'sending'
  | 'responseReceived'
  | 'verifiedSuccess'
  | 'verifiedMismatch'
  | 'unknown'
  | 'error';

export type SubmissionOperation = {
  id: string;
  type: 'create' | 'delete';
  serviceName: string;
  clientName: string;
  clientId: string;
  serviceId: string;
  targetCount: number;
  originalCount: number;
  observedCount: number;
  status: SubmissionOperationStatus;
  lastMessage?: string;
};

export type SubmissionChange = {
  serviceName: string;
  clientId: string;
  clientName: string;
  serviceId: string;
  targetCount: number;
  originalCount: number;
};

type ExecuteParams = {
  api: ApiService;
  sessionId: string;
  date: string;
  changes: SubmissionChange[];
  maxRetries?: number;
  concurrency?: number;
  onOperationUpdate?: (index: number, patch: Partial<SubmissionOperation>) => void;
  onProgressMessage?: (message: string) => void;
};

export type ExecuteResult = {
  operations: SubmissionOperation[];
  verifiedSuccess: number;
  failed: number;
  unknown: number;
};

type CellQuota = {
  observedCount: number;
  inFlight: number;
  claimedDeleteIds: Set<string>;
};

type VisitUnit = {
  index: number;
  type: 'create' | 'delete';
};

export const SUBMISSION_CONCURRENCY = 20;
export const SUBMISSION_MAX_ATTEMPTS = 10;

const runConcurrent = async <T,>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> => {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  };

  await Promise.all(Array(Math.min(concurrency, tasks.length)).fill(null).map(worker));
  return results;
};

const classifyAttempt = (attemptResult: boolean): SubmissionOperationStatus => {
  if (attemptResult === true) {
    return 'responseReceived';
  }
  return 'unknown';
};

export const executeReliableSubmission = async ({
  api,
  sessionId,
  date,
  changes,
  maxRetries,
  concurrency = SUBMISSION_CONCURRENCY,
  onOperationUpdate,
  onProgressMessage
}: ExecuteParams): Promise<ExecuteResult> => {
  const maxAttempts =
    maxRetries !== undefined ? maxRetries + 1 : SUBMISSION_MAX_ATTEMPTS;
  const operations: SubmissionOperation[] = changes.map((change, idx) => ({
    id: `${change.clientId}_${change.serviceId}_${idx}`,
    type: change.targetCount >= change.originalCount ? 'create' : 'delete',
    serviceName: change.serviceName,
    clientName: change.clientName,
    clientId: change.clientId,
    serviceId: change.serviceId,
    targetCount: change.targetCount,
    originalCount: change.originalCount,
    observedCount: change.originalCount,
    status: 'pending'
  }));

  const quotas: CellQuota[] = operations.map((operation) => ({
    observedCount: operation.originalCount,
    inFlight: 0,
    claimedDeleteIds: new Set<string>()
  }));

  const setOp = (index: number, patch: Partial<SubmissionOperation>) => {
    operations[index] = { ...operations[index], ...patch };
    onOperationUpdate?.(index, patch);
  };

  const units: VisitUnit[] = [];
  const remainingUnits = operations.map(() => 0);

  const finalizeCell = async (index: number) => {
    const operation = operations[index];
    const finalVisitIds = await api.getVisitIds(
      operation.clientId,
      operation.serviceId,
      sessionId
    );
    if (finalVisitIds.length === operation.targetCount) {
      setOp(index, {
        observedCount: finalVisitIds.length,
        status: 'verifiedSuccess',
        lastMessage: 'Подтверждено чтением с сервера'
      });
    } else {
      setOp(index, {
        observedCount: finalVisitIds.length,
        status: 'verifiedMismatch',
        lastMessage: `Ожидалось ${operation.targetCount}, получено ${finalVisitIds.length}`
      });
    }
  };

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const visitIds = await api.getVisitIds(operation.clientId, operation.serviceId, sessionId);
    quotas[index].observedCount = visitIds.length;
    setOp(index, {
      observedCount: visitIds.length,
      status: 'sending',
      lastMessage: 'Начало отправки'
    });

    const residual = operation.targetCount - visitIds.length;
    const type: VisitUnit['type'] = residual >= 0 ? 'create' : 'delete';
    if (residual !== 0) {
      setOp(index, { type });
    }
    for (let i = 0; i < Math.abs(residual); i += 1) {
      units.push({ index, type });
      remainingUnits[index] += 1;
    }
    if (remainingUnits[index] === 0) {
      await finalizeCell(index);
    }
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const runUnit = async (unit: VisitUnit) => {
    const operation = operations[unit.index];
    const quota = quotas[unit.index];
    let attempt = 0;

    while (attempt < maxAttempts) {
      const visitIds = await api.getVisitIds(operation.clientId, operation.serviceId, sessionId);
      quota.observedCount = visitIds.length;
      setOp(unit.index, { observedCount: visitIds.length });

      const hasReachedTarget =
        unit.type === 'create'
          ? visitIds.length >= operation.targetCount
          : visitIds.length <= operation.targetCount;

      if (hasReachedTarget) {
        return;
      }

      const canReserve =
        unit.type === 'create'
          ? quota.observedCount + quota.inFlight < operation.targetCount
          : quota.observedCount - quota.inFlight > operation.targetCount;

      if (!canReserve) {
        await sleep(150 * Math.max(attempt, 1));
        continue;
      }

      attempt += 1;
      onProgressMessage?.(
        `Обработка ${operation.clientName} / ${operation.serviceName}: попытка ${attempt}/${maxAttempts}`
      );
      quota.inFlight += 1;
      let claimedId: string | undefined;
      let requestOk = true;
      let reachedTargetAfterAttempt = false;

      try {
        if (unit.type === 'create') {
          requestOk = await api.createServiceVisit({
            clientId: operation.clientId,
            serviceId: operation.serviceId,
            sessionId,
            date,
            hours: 0,
            minutes: 30
          });
        } else {
          const available = visitIds.filter((id) => !quota.claimedDeleteIds.has(id));
          claimedId = available[0];
          if (!claimedId) {
            requestOk = false;
          } else {
            quota.claimedDeleteIds.add(claimedId);
            requestOk = await api.deleteServiceVisit({
              visitId: claimedId,
              clientId: operation.clientId,
              serviceId: operation.serviceId,
              sessionId,
              date,
              hours: 0,
              minutes: 30
            });
          }
        }
        setOp(unit.index, {
          status: classifyAttempt(requestOk),
          lastMessage: requestOk ? 'Ответ получен, идет верификация' : 'Ответ неоднозначен'
        });
      } finally {
        const verifyIds = await api.getVisitIds(
          operation.clientId,
          operation.serviceId,
          sessionId
        );
        quota.observedCount = verifyIds.length;
        if (claimedId) {
          quota.claimedDeleteIds.delete(claimedId);
        }
        quota.inFlight -= 1;
        setOp(unit.index, { observedCount: verifyIds.length });
        reachedTargetAfterAttempt = verifyIds.length === operation.targetCount;
      }

      if (reachedTargetAfterAttempt) {
        return;
      }

      if (attempt < maxAttempts) {
        await sleep(150 * attempt);
      }
    }
  };

  await runConcurrent(
    units.map((unit) => async () => {
      try {
        await runUnit(unit);
      } catch {
        // A thrown mutation spends this unit; final verification decides the cell status.
      } finally {
        remainingUnits[unit.index] -= 1;
        if (remainingUnits[unit.index] === 0) {
          await finalizeCell(unit.index);
        }
      }
    }),
    concurrency
  );

  const verifiedSuccess = operations.filter((op) => op.status === 'verifiedSuccess').length;
  const unknown = operations.filter((op) => op.status === 'unknown').length;
  const failed = operations.filter(
    (op) => op.status === 'verifiedMismatch' || op.status === 'error'
  ).length;

  return {
    operations,
    verifiedSuccess,
    failed,
    unknown
  };
};

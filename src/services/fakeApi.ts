import type { ApiService } from './apiContract';
import type { Client, ReportData, Service, ServiceRendered, ServiceWithVisits } from '../types';

type VisitRecord = {
  id: string;
  date: string;
  hours: number;
  minutes: number;
};

const DEMO_ORGANIZATION = 'Демонстрационная организация';

const fakeServices: Service[] = Array.from({ length: 10 }, (_, index) => ({
  id: String(index + 1),
  name: `Демонстрационная услуга ${String(index + 1).padStart(2, '0')}`,
  code: `ДЕМО-${index + 1}`,
  timeMinutes: 10 + index * 5,
  volumeTerms: String(index + 1)
}));

const fakeClients: Client[] = [
  { id: 'demo-client-1', fullName: 'Иванов Иван Иванович' },
  { id: 'demo-client-2', fullName: 'Петров Петр Петрович' },
  { id: 'demo-client-3', fullName: 'Сидорова Анна Николаевна' },
  { id: 'demo-client-4', fullName: 'Кузнецов Сергей Васильевич' },
  { id: 'demo-client-5', fullName: 'Смирнова Мария Алексеевна' }
];

const visitsByClientService = new Map<string, VisitRecord[]>();
let visitSequence = 500000;
type FakeFaultConfig = {
  latencyMs: number;
  createFalseNegativeRate: number;
  deleteFalseNegativeRate: number;
  hardFailCreateKeys: string[];
};

const fakeFaultConfig: FakeFaultConfig = {
  latencyMs: 0,
  createFalseNegativeRate: 0,
  deleteFalseNegativeRate: 0,
  hardFailCreateKeys: []
};

export const configureFakeApiFaults = (next: Partial<FakeFaultConfig>) => {
  Object.assign(fakeFaultConfig, next);
};

export const resetFakeApiState = () => {
  visitsByClientService.clear();
  visitSequence = 500000;
  fakeFaultConfig.latencyMs = 0;
  fakeFaultConfig.createFalseNegativeRate = 0;
  fakeFaultConfig.deleteFalseNegativeRate = 0;
  fakeFaultConfig.hardFailCreateKeys = [];
};

const randomInt = (min: number, max: number): number => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const ensureSeedData = (): void => {
  if (visitsByClientService.size > 0) {
    return;
  }

  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];

  fakeClients.forEach((client) => {
    fakeServices.forEach((service) => {
      const key = `${client.id}_${service.id}`;
      const visits: VisitRecord[] = [];
      const count = client.id === fakeClients[0].id && service.id === fakeServices[0].id
        ? 1
        : Math.random() > 0.35 ? randomInt(0, 4) : 0;

      for (let i = 0; i < count; i += 1) {
        visitSequence += 1;
        visits.push({
          id: String(visitSequence),
          date: currentDate,
          hours: 0,
          minutes: 30
        });
      }

      visitsByClientService.set(key, visits);
    });
  });
};

const getKey = (clientId: string, serviceId: string): string => `${clientId}_${serviceId}`;

const getClientServices = (clientId: string): ServiceWithVisits[] => {
  ensureSeedData();
  return fakeServices
    .map((service) => {
      const key = getKey(clientId, service.id);
      const visits = visitsByClientService.get(key) ?? [];
      return {
        id: service.id,
        name: service.name,
        visits: visits.length
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
};

const decodeHtmlEntities = (text: string): string => {
  if (typeof document === 'undefined') {
    return text;
  }
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  return textarea.value;
};

const maybeDelay = async (): Promise<void> => {
  if (fakeFaultConfig.latencyMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, fakeFaultConfig.latencyMs));
  }
};

export const fakeApiService: ApiService = {
  async login(username: string, password: string) {
    if (!username || !password) {
      return { success: false, error: 'Введите имя пользователя и пароль' };
    }

    ensureSeedData();
    const sessionId = `fake-${Date.now()}`;

    if (typeof document !== 'undefined') {
      document.cookie = `LOGIN_USERNAME_COOKIE=${username}; path=/; SameSite=Lax`;
    }

    return {
      success: true,
      token: sessionId,
      sessionId
    };
  },

  async getServices() {
    return fakeServices;
  },

  parseServicesFromHtml() {
    return [];
  },

  async getAvailableServices(clientCodPerson: string, sessionId?: string) {
    if (!sessionId) {
      return [];
    }
    return getClientServices(clientCodPerson);
  },

  async getVisitIds(clientId: string, serviceId: string, sessionId?: string) {
    if (!sessionId) {
      return [];
    }

    ensureSeedData();
    const key = getKey(clientId, serviceId);
    const visits = visitsByClientService.get(key) ?? [];
    return visits.map((visit) => visit.id);
  },

  async getServiceVisitCount(clientId: string, serviceId: string, sessionId?: string) {
    if (!sessionId) {
      return 0;
    }
    const visitIds = await this.getVisitIds(clientId, serviceId, sessionId);
    return visitIds.length;
  },

  async getPage4Params(clientId: string, serviceId: string, sessionId?: string) {
    if (!sessionId) {
      return null;
    }

    return {
      salt: sessionId,
      protected: 'fake-protected',
      pInstance: sessionId,
      pPageSubmissionId: sessionId,
      codSsd: `ssd-${serviceId}`,
      codSorg: `sorg-${clientId}`,
      codPo: 'fake-po',
      pageUrl: `fake://page4/${clientId}/${serviceId}`
    };
  },

  async createServiceVisit(params) {
    const { clientId, serviceId, sessionId, date, hours = 0, minutes = 30 } = params;
    if (!sessionId) {
      return false;
    }

    await maybeDelay();
    const key = getKey(clientId, serviceId);
    if (fakeFaultConfig.hardFailCreateKeys.includes(key)) {
      return false;
    }
    ensureSeedData();
    const visits = visitsByClientService.get(key) ?? [];
    visitSequence += 1;
    visits.push({
      id: String(visitSequence),
      date,
      hours,
      minutes
    });
    visitsByClientService.set(key, visits);
    if (Math.random() < fakeFaultConfig.createFalseNegativeRate) {
      return false;
    }
    return true;
  },

  async deleteServiceVisit(params) {
    const { visitId, clientId, serviceId, sessionId } = params;
    if (!sessionId) {
      return false;
    }

    await maybeDelay();
    ensureSeedData();
    const key = getKey(clientId, serviceId);
    const visits = visitsByClientService.get(key) ?? [];
    const nextVisits = visits.filter((visit) => visit.id !== visitId);
    const removed = nextVisits.length !== visits.length;
    visitsByClientService.set(key, nextVisits);
    if (removed && Math.random() < fakeFaultConfig.deleteFalseNegativeRate) {
      return false;
    }
    return removed;
  },

  async verifyServiceVisitCreated(clientId, serviceId, sessionId, expectedCount = 1) {
    const visitIds = await this.getVisitIds(clientId, serviceId, sessionId);
    return visitIds.length >= expectedCount;
  },

  async verifyServiceVisitDeleted(visitId, clientId, serviceId, sessionId) {
    const visitIds = await this.getVisitIds(clientId, serviceId, sessionId);
    return !visitIds.includes(visitId);
  },

  invalidatePage4Cache() {
    // Fake mode does not cache page params.
  },

  async consolidateServiceDuplicates(_clientId, services) {
    return services;
  },

  async getAllClientsServices(sessionId?: string) {
    const servicesMap = new Map<string, ServiceWithVisits[]>();
    if (!sessionId) {
      return servicesMap;
    }

    ensureSeedData();

    const clients = await this.getClients(sessionId);
    clients.forEach((client) => {
      servicesMap.set(client.id, getClientServices(client.id));
    });

    return servicesMap;
  },

  decodeHtmlEntities(text: string) {
    return decodeHtmlEntities(text);
  },

  async getClients(sessionId?: string, forceRefresh = false) {
    if (!sessionId) {
      return fakeClients;
    }

    const sorted = [...fakeClients].sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));

    if (typeof localStorage !== 'undefined') {
      if (forceRefresh || !localStorage.getItem('clients_cache')) {
        localStorage.setItem('clients_cache', JSON.stringify(sorted));
      }
      localStorage.setItem('social_worker_name', 'Тестовый Соцработник П.П.');
      localStorage.setItem('organization_name', DEMO_ORGANIZATION);
    }

    return sorted;
  },

  async getReport(sessionId?: string): Promise<ReportData> {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const clients = await this.getClients(sessionId);

    ensureSeedData();
    const serviceRendered: ServiceRendered[] = [];
    clients.forEach((client) => {
      fakeServices.forEach((service) => {
        const key = getKey(client.id, service.id);
        const visits = visitsByClientService.get(key) ?? [];
        if (visits.length > 0) {
          serviceRendered.push({
            serviceId: service.id,
            clientId: client.id,
            count: visits.length
          });
        }
      });
    });

    return {
      services: fakeServices,
      clients,
      serviceRendered,
      period: {
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0]
      },
      socialWorker: 'Тестовый Соцработник П.П.',
      organization: DEMO_ORGANIZATION
    };
  }
};

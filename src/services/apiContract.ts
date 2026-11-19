import type { Client, ReportData, Service, ServiceWithVisits } from '../types';

export interface ApiService {
  login(
    username: string,
    password: string
  ): Promise<{
    success: boolean;
    token?: string;
    sessionId?: string;
    error?: string;
    htmlResponse?: string;
  }>;
  getServices(): Promise<Service[]>;
  parseServicesFromHtml(html: string): ServiceWithVisits[];
  getAvailableServices(clientCodPerson: string, sessionId?: string): Promise<ServiceWithVisits[]>;
  getVisitIds(clientId: string, serviceId: string, sessionId?: string): Promise<string[]>;
  getServiceVisitCount(clientId: string, serviceId: string, sessionId?: string): Promise<number>;
  getPage4Params(
    clientId: string,
    serviceId: string,
    sessionId?: string,
    useCache?: boolean
  ): Promise<{
    salt: string;
    protected: string;
    pInstance: string;
    pPageSubmissionId: string;
    codSsd: string;
    codSorg: string;
    codPo: string;
    pageUrl: string;
  } | null>;
  createServiceVisit(params: {
    clientId: string;
    serviceId: string;
    sessionId: string;
    date: string;
    hours?: number;
    minutes?: number;
  }): Promise<boolean>;
  deleteServiceVisit(params: {
    visitId: string;
    clientId: string;
    serviceId: string;
    sessionId: string;
    date: string;
    hours?: number;
    minutes?: number;
  }): Promise<boolean>;
  verifyServiceVisitCreated(
    clientId: string,
    serviceId: string,
    sessionId: string,
    expectedCount?: number
  ): Promise<boolean>;
  verifyServiceVisitDeleted(
    visitId: string,
    clientId: string,
    serviceId: string,
    sessionId: string
  ): Promise<boolean>;
  invalidatePage4Cache(clientId: string, serviceId: string, sessionId: string): void;
  consolidateServiceDuplicates(
    clientId: string,
    services: ServiceWithVisits[],
    sessionId: string
  ): Promise<ServiceWithVisits[]>;
  getAllClientsServices(sessionId?: string): Promise<Map<string, ServiceWithVisits[]>>;
  decodeHtmlEntities(text: string): string;
  getClients(sessionId?: string, forceRefresh?: boolean, htmlResponse?: string): Promise<Client[]>;
  getReport(sessionId?: string): Promise<ReportData>;
}

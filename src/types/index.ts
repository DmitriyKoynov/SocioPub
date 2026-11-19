// Тип для услуги
export interface Service {
  id: string;
  name: string;
  code: string;
  timeMinutes: number;
  volumeTerms: string;
}

// Тип для клиента
export interface Client {
  id: string;
  fullName: string;
}

// Тип для данных о предоставленной услуге
export interface ServiceRendered {
  serviceId: string;
  clientId: string;
  count: number; // Количество раз оказания услуги
}

// Тип для услуги с количеством посещений (из HTML ответа)
export interface ServiceWithVisits {
  id: string; // P3_COD_WSD
  name: string; // Название услуги
  visits: number; // Количество посещений (всего)
}

// Тип для отчета
export interface ReportData {
  services: Service[];
  clients: Client[];
  serviceRendered: ServiceRendered[];
  period: {
    start: string;
    end: string;
  };
  socialWorker: string;
  organization: string;
}


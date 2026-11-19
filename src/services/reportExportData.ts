import { SOURCE_TO_REPORT_NAMES } from './serviceNameMapping';

export interface ExportServiceRow {
  name: string;
  visitsByClientId: ReadonlyMap<string, number>;
}

export function mapServicesForReport(
  sourceServices: readonly ExportServiceRow[],
  clientIds: readonly string[],
  templateServiceNames: readonly string[]
): ExportServiceRow[] {
  const visitsByReportName = new Map<string, Map<string, number>>();

  sourceServices.forEach(({ name, visitsByClientId }) => {
    const reportNames = SOURCE_TO_REPORT_NAMES[name];
    if (!reportNames?.length) {
      return;
    }

    reportNames.forEach((reportName) => {
      let totals = visitsByReportName.get(reportName);
      if (!totals) {
        totals = new Map(clientIds.map((clientId) => [clientId, 0]));
        visitsByReportName.set(reportName, totals);
      }

      clientIds.forEach((clientId) => {
        const visits = visitsByClientId.get(clientId) ?? 0;
        totals!.set(clientId, (totals!.get(clientId) ?? 0) + visits);
      });
    });
  });

  return templateServiceNames.flatMap((name) => {
    const visitsByClientId = visitsByReportName.get(name);
    if (!visitsByClientId || !clientIds.some((clientId) => (visitsByClientId.get(clientId) ?? 0) > 0)) {
      return [];
    }

    return [{ name, visitsByClientId }];
  });
}

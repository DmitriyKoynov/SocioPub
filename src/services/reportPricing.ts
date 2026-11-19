import { SOURCE_TO_REPORT_NAMES } from './serviceNameMapping';
import { loadReportTemplateTariffs } from './reportTemplate';

export async function loadWebsiteServiceTariffs(): Promise<Record<string, number>> {
  const reportTariffs = await loadReportTemplateTariffs();
  const websiteTariffs: Record<string, number> = {};

  Object.entries(SOURCE_TO_REPORT_NAMES).forEach(([sourceName, reportNames]) => {
    if (reportNames.length === 0) {
      return;
    }

    const mappedTariffs = reportNames.map((name) => reportTariffs[name]);
    if (mappedTariffs.every((tariff) => typeof tariff === 'number')) {
      // A source service mapped to multiple report rows contributes to each row's tariff.
      websiteTariffs[sourceName] = mappedTariffs.reduce((sum, tariff) => sum + (tariff ?? 0), 0);
    }
  });

  return websiteTariffs;
}

export function formatRublesHuman(amount: number): string {
  const totalKop = Math.round(amount * 100);
  const rub = Math.floor(totalKop / 100);
  const kop = Math.abs(totalKop % 100);
  return `${rub} руб, ${String(kop).padStart(2, '0')} коп`;
}

export function computeClientTotalRub(
  clientId: string,
  serviceNames: string[],
  getVisits: (serviceName: string, clientId: string) => number,
  prices: Record<string, number>
): number {
  return serviceNames.reduce(
    (sum, name) => sum + getVisits(name, clientId) * (prices[name] ?? 0),
    0
  );
}

export function computeGrandTotalRub(
  serviceNames: string[],
  clientIds: string[],
  getVisits: (serviceName: string, clientId: string) => number,
  prices: Record<string, number>
): number {
  return serviceNames.reduce((sum, name) => {
    const serviceTotal = clientIds.reduce(
      (clientSum, clientId) => clientSum + getVisits(name, clientId),
      0
    );
    return sum + serviceTotal * (prices[name] ?? 0);
  }, 0);
}

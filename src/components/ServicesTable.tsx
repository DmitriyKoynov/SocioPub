import { useState, useEffect, useRef } from 'react';
import type { Client, ServiceWithVisits } from '../types';
import { apiService } from '../services/api';
import {
  executeReliableSubmission,
  type SubmissionOperation
} from '../services/submissionOrchestrator';
import { exportReportToXlsx } from '../services/exportReport';
import {
  computeClientTotalRub,
  computeGrandTotalRub,
  formatRublesHuman,
  loadWebsiteServiceTariffs
} from '../services/reportPricing';
import { useAuth } from '../context/AuthContext';
import './ServicesTable.css';

// Уникальная услуга определяется только по названию
interface UniqueService {
  name: string;
}

const ServicesTable = () => {
  const { sessionId } = useAuth();
  const [uniqueServices, setUniqueServices] = useState<UniqueService[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [socialWorker, setSocialWorker] = useState('Неизвестно');
  const [organization, setOrganization] = useState('');
  const [period, setPeriod] = useState({ start: '', end: '' });
  const [serviceTariffs, setServiceTariffs] = useState<Record<string, number>>({});
  // Состояние для фильтрации по названию услуги
  const [serviceFilter, setServiceFilter] = useState('');
  // Состояние для редактируемых значений посещений: Map<serviceName, Map<clientId, visits>>
  const [editableVisits, setEditableVisits] = useState<Map<string, Map<string, number>>>(new Map());
  // Состояние для исходных значений посещений с сервера (для сравнения)
  const [originalVisits, setOriginalVisits] = useState<Map<string, Map<string, number>>>(new Map());
  // Маппинг выбранных услуг: Map<serviceName, Map<clientId, serviceId>>
  const [serviceIdMap, setServiceIdMap] = useState<Map<string, Map<string, string>>>(new Map());
  // Состояние для отслеживания прогресса отправки
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [hasConfirmedRefresh, setHasConfirmedRefresh] = useState(false);
  const [progress, setProgress] = useState({
    total: 0,
    completed: 0,
    failed: 0,
    currentOperation: '',
    operations: [] as SubmissionOperation[]
  });
  // Ref для элемента report-header
  const reportHeaderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isCurrent = true;
    loadWebsiteServiceTariffs()
      .then((tariffs) => {
        if (isCurrent) {
          setServiceTariffs(tariffs);
        }
      })
      .catch((error) => {
        console.error('Не удалось загрузить тарифы из шаблона отчета:', error);
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  const buildVisitsState = (
    servicesData: Map<string, ServiceWithVisits[]>,
    clientsList: Client[]
  ): {
    uniqueServices: UniqueService[];
    editableVisits: Map<string, Map<string, number>>;
    originalVisits: Map<string, Map<string, number>>;
    serviceIdMap: Map<string, Map<string, string>>;
  } => {
    const uniqueNames = new Set<string>();

    servicesData.forEach((serviceCollection) => {
      serviceCollection.forEach((service) => {
        uniqueNames.add(service.name);
      });
    });

    const uniqueServicesArray = Array.from(uniqueNames)
      .map(name => ({ name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    const editable = new Map<string, Map<string, number>>();
    const original = new Map<string, Map<string, number>>();
    const serviceIdMapping = new Map<string, Map<string, string>>();

    uniqueServicesArray.forEach(service => {
      const clientVisits = new Map<string, number>();
      const originalClientVisits = new Map<string, number>();
      const clientServiceIds = new Map<string, string>();

      clientsList.forEach(client => {
        const clientServices = servicesData.get(client.id);
        if (!clientServices) {
          clientVisits.set(client.id, 0);
          originalClientVisits.set(client.id, 0);
          return;
        }

        const duplicates = clientServices.filter(s => s.name === service.name);
        
        if (duplicates.length === 0) {
          clientVisits.set(client.id, 0);
          originalClientVisits.set(client.id, 0);
          return;
        }

        const totalVisits = duplicates.reduce((sum, s) => sum + s.visits, 0);
        const servicesWithVisits = duplicates.filter(s => s.visits > 0);
        
        let selectedService: ServiceWithVisits;
        if (servicesWithVisits.length > 0) {
          selectedService = servicesWithVisits.reduce((max, s) => 
            s.visits > max.visits ? s : max
          );
        } else {
          selectedService = duplicates[0];
        }

        clientServiceIds.set(client.id, selectedService.id);
        clientVisits.set(client.id, totalVisits);
        originalClientVisits.set(client.id, totalVisits);
      });

      editable.set(service.name, clientVisits);
      original.set(service.name, originalClientVisits);
      serviceIdMapping.set(service.name, clientServiceIds);
    });

    return {
      uniqueServices: uniqueServicesArray,
      editableVisits: editable,
      originalVisits: original,
      serviceIdMap: serviceIdMapping
    };
  };

  useEffect(() => {
    const loadData = async () => {
      try {
        if (import.meta.env.VITE_API_MODE !== 'real' && sessionId) {
          await apiService.getClients(sessionId);
        }
        // Получаем клиентов из localStorage
        const clientsCache = localStorage.getItem('clients_cache');
        if (!clientsCache) {
          console.warn('⚠️ No clients in localStorage');
          setLoading(false);
          return;
        }
        
        const loadedClients: Client[] = JSON.parse(clientsCache);
        const sortedClients = [...loadedClients].sort((a, b) => 
          a.fullName.localeCompare(b.fullName, 'ru')
        );
        setClients(sortedClients);

        // Получаем ФИО социального работника
        const workerName = localStorage.getItem('social_worker_name') || 'Неизвестно';
        setSocialWorker(workerName);

        // Получаем организацию
        const orgName = localStorage.getItem('organization_name') || '';
        setOrganization(orgName);

        // Вычисляем период - текущий месяц
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        
        // Форматируем даты в формат ДД.ММ.ГГГГ
        const formatDate = (date: Date): string => {
          const day = String(date.getDate()).padStart(2, '0');
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const year = date.getFullYear();
          return `${day}.${month}.${year}`;
        };
        
        setPeriod({
          start: formatDate(start),
          end: formatDate(end)
        });

        // Загружаем услуги для всех клиентов параллельно
        let allServices = await apiService.getAllClientsServices(sessionId || undefined);
        
        // Консолидируем дубли услуг для каждого клиента
        if (sessionId) {
          let needsConsolidation = false;
          
          for (const client of sortedClients) {
            const clientServices = allServices.get(client.id);
            if (clientServices && clientServices.length > 0) {
              const serviceGroups = new Map<string, ServiceWithVisits[]>();
              clientServices.forEach(service => {
                const existing = serviceGroups.get(service.name) || [];
                existing.push(service);
                serviceGroups.set(service.name, existing);
              });
              
              for (const [, duplicates] of serviceGroups.entries()) {
                if (duplicates.length > 1) {
                  const servicesWithVisits = duplicates.filter(s => s.visits > 0);
                  if (servicesWithVisits.length > 1) {
                    needsConsolidation = true;
                    break;
                  }
                }
              }
              
              if (needsConsolidation) {
                break;
              }
            }
          }
          
          if (needsConsolidation) {
            for (const client of sortedClients) {
              const clientServices = allServices.get(client.id);
              if (clientServices && clientServices.length > 0) {
                try {
                  await apiService.consolidateServiceDuplicates(
                    client.id,
                    clientServices,
                    sessionId
                  );
                } catch (error) {
                  console.error(`❌ Error consolidating services for client ${client.id}:`, error);
                }
              }
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            allServices = await apiService.getAllClientsServices(sessionId);
          }
        }
        

        const {
          uniqueServices: uniqueServicesArray,
          editableVisits: initialEditableVisits,
          originalVisits: initialOriginalVisits,
          serviceIdMap: initialServiceIdMap
        } = buildVisitsState(allServices, sortedClients);

        setUniqueServices(uniqueServicesArray);
        setEditableVisits(initialEditableVisits);
        setOriginalVisits(initialOriginalVisits);
        setServiceIdMap(initialServiceIdMap);

      } catch (error) {
        console.error('Ошибка загрузки данных:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [sessionId]);

  // Обработчик прокрутки для фиксации report-header только по горизонтали
  useEffect(() => {
    let rafId = 0;
    const handleScroll = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        if (!reportHeaderRef.current) {
          return;
        }
        const scrollContainer = document.querySelector('.app-scroll-wrapper');
        const scrollLeft = scrollContainer
          ? scrollContainer.scrollLeft
          : (window.scrollX || document.documentElement.scrollLeft || document.body.scrollLeft || 0);
        reportHeaderRef.current.style.transform = `translate3d(${scrollLeft}px, 0, 0)`;
      });
    };

    // Проверяем, есть ли прокручиваемый контейнер .app-scroll-wrapper
    const scrollContainer = document.querySelector('.app-scroll-wrapper');
    
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', handleScroll);
      // Вызываем сразу для установки начальной позиции
      handleScroll();
      
      return () => {
        if (rafId) {
          cancelAnimationFrame(rafId);
        }
        scrollContainer.removeEventListener('scroll', handleScroll);
      };
    } else {
      // Если контейнера нет, используем window
      window.addEventListener('scroll', handleScroll);
      // Вызываем сразу для установки начальной позиции
      handleScroll();
      
      return () => {
        if (rafId) {
          cancelAnimationFrame(rafId);
        }
        window.removeEventListener('scroll', handleScroll);
      };
    }
  }, []);

  // Функция для получения количества посещений из редактируемого состояния
  const getEditableVisitsCount = (serviceName: string, clientId: string): number => {
    const serviceVisits = editableVisits.get(serviceName);
    if (!serviceVisits) {
      return 0;
    }
    return serviceVisits.get(clientId) || 0;
  };

  // Функция для получения выбранного serviceId из маппинга
  const getSelectedServiceId = (serviceName: string, clientId: string): string | undefined => {
    return serviceIdMap.get(serviceName)?.get(clientId);
  };

  // Функция для обновления количества посещений
  const updateVisitsCount = (serviceName: string, clientId: string, value: number) => {
    // Ограничиваем максимальное значение 999
    const clampedValue = Math.min(Math.max(value, 0), 999);
    
    setEditableVisits(prev => {
      const newMap = new Map(prev);
      const serviceVisits = newMap.get(serviceName) || new Map<string, number>();
      serviceVisits.set(clientId, clampedValue);
      newMap.set(serviceName, serviceVisits);
      return newMap;
    });
  };

  // Обработчик для блокировки ввода нечисловых символов
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Разрешаем служебные клавиши
    const allowedKeys = [
      'Backspace', 'Delete', 'Tab', 'Enter', 'Escape',
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
      'Home', 'End'
    ];

    // Разрешаем комбинации с Ctrl/Cmd
    if (e.ctrlKey || e.metaKey) {
      if (['a', 'c', 'v', 'x'].includes(e.key.toLowerCase())) {
        return; // Разрешаем Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X
      }
    }

    // Разрешаем служебные клавиши
    if (allowedKeys.includes(e.key)) {
      return;
    }

    // Разрешаем только цифры
    if (!/^[0-9]$/.test(e.key)) {
      e.preventDefault();
    }
  };

  // Обработчик для вставки текста (оставляем только цифры)
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedText = e.clipboardData.getData('text');
    const numbersOnly = pastedText.replace(/\D/g, '');
    
    if (numbersOnly) {
      const value = parseInt(numbersOnly, 10) || 0;
      const clampedValue = Math.min(Math.max(value, 0), 999);
      
      // Находим serviceName и clientId из контекста
      // Это будет установлено через data-атрибуты или через замыкание
      const target = e.currentTarget;
      const serviceName = target.dataset.serviceName || '';
      const clientId = target.dataset.clientId || '';
      
      if (serviceName && clientId) {
        updateVisitsCount(serviceName, clientId, clampedValue);
      }
    }
  };

  // Функция для проверки, изменилось ли значение относительно исходного
  const hasChanged = (serviceName: string, clientId: string): boolean => {
    const originalValue = originalVisits.get(serviceName)?.get(clientId) || 0;
    const currentValue = editableVisits.get(serviceName)?.get(clientId) || 0;
    return originalValue !== currentValue;
  };

  // Функция для форматирования ФИО в формат "Фамилия И.О."
  const formatClientNameShort = (fullName: string): string => {
    const parts = fullName.trim().split(/\s+/).filter(part => part.length > 0);
    if (parts.length === 0) return fullName;
    if (parts.length === 1) return parts[0];
    
    const surname = parts[0];
    const initials = parts.slice(1).map(part => {
      if (part.length > 0) {
        return `${part[0].toUpperCase()}.`;
      }
      return '';
    }).join(' ');
    
    return `${surname} ${initials}`.trim();
  };

  // Функция для группировки операций по клиенту, услуге и типу
  const getGroupedOperations = () => {
    const grouped = new Map<string, {
      clientId: string;
      clientName: string;
      serviceName: string;
      type: 'create' | 'delete';
      total: number;
      successful: number;
      failed: number;
      inProgress: number;
    }>();

    progress.operations.forEach(op => {
      const key = `${op.clientId}_${op.serviceName}_${op.type}`;
      const units = Math.abs(op.targetCount - op.originalCount) || 1;
      const observed = typeof op.observedCount === 'number' ? op.observedCount : op.originalCount;
      const rawAchieved = op.type === 'create'
        ? observed - op.originalCount
        : op.originalCount - observed;
      const achievedUnits = Math.max(0, Math.min(units, rawAchieved));
      const existing = grouped.get(key);
      
      if (existing) {
        existing.total += units;
        if (op.status === 'verifiedSuccess') {
          existing.successful += units;
        } else if (op.status === 'verifiedMismatch' || op.status === 'error' || op.status === 'unknown') {
          existing.successful += achievedUnits;
          existing.failed += Math.max(units - achievedUnits, 0);
        } else if (op.status === 'pending' || op.status === 'sending' || op.status === 'responseReceived') {
          existing.successful += achievedUnits;
          existing.inProgress += Math.max(units - achievedUnits, 0);
        }
      } else {
        grouped.set(key, {
          clientId: op.clientId,
          clientName: op.clientName,
          serviceName: op.serviceName,
          type: op.type,
          total: units,
          successful: op.status === 'verifiedSuccess' ? units : 0,
          failed: (op.status === 'verifiedMismatch' || op.status === 'error' || op.status === 'unknown')
            ? Math.max(units - achievedUnits, 0)
            : 0,
          inProgress: (op.status === 'pending' || op.status === 'sending' || op.status === 'responseReceived')
            ? Math.max(units - achievedUnits, 0)
            : 0
        });
        if (op.status !== 'verifiedSuccess') {
          const item = grouped.get(key)!;
          item.successful += achievedUnits;
        }
      }
    });

    return Array.from(grouped.values()).sort((a, b) => {
      const nameCompare = a.clientName.localeCompare(b.clientName, 'ru');
      if (nameCompare !== 0) return nameCompare;
      const serviceCompare = a.serviceName.localeCompare(b.serviceName, 'ru');
      if (serviceCompare !== 0) return serviceCompare;
      return a.type.localeCompare(b.type);
    });
  };

  // Функция для определения статуса операции
  const getOperationStatus = (group: {
    successful: number;
    failed: number;
    inProgress: number;
    total: number;
  }): string => {
    if (group.inProgress > 0) {
      return '⏳';
    }
    if (group.failed > 0) {
      return '❌';
    }
    if (group.successful === group.total) {
      return '✅';
    }
    return '⏳';
  };

  if (loading) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Загрузка данных...</p>
      </div>
    );
  }

  // Вычисление статистики для каждой услуги (по названию) на основе редактируемых значений
  const getServiceStats = (serviceName: string) => {
    let totalVisits = 0;
    clients.forEach((client) => {
      totalVisits += getEditableVisitsCount(serviceName, client.id);
    });
    return { totalVisits };
  };

  // Функция для получения суммы всех посещений по всем услугам клиента
  const getClientServicesCount = (clientId: string): number => {
    let totalVisits = 0;
    uniqueServices.forEach(service => {
      const visits = getEditableVisitsCount(service.name, clientId);
      totalVisits += visits;
    });
    return totalVisits;
  };

  // Функция для получения общего суммарного количества посещений по всем услугам и всем клиентам
  const getTotalVisitsCount = (): number => {
    let totalVisits = 0;
    uniqueServices.forEach(service => {
      clients.forEach(client => {
        const visits = getEditableVisitsCount(service.name, client.id);
        totalVisits += visits;
      });
    });
    return totalVisits;
  };

  // Фильтрация услуг по названию
  const filteredServices = uniqueServices.filter(service => {
    if (!serviceFilter.trim()) {
      return true;
    }
    return service.name.toLowerCase().includes(serviceFilter.toLowerCase());
  });

  const calcFailedCount = (ops: SubmissionOperation[]): number =>
    ops.filter((op) => op.status === 'verifiedMismatch' || op.status === 'error' || op.status === 'unknown').length;

  // Обработчик отправки данных на сервер
  const handleSubmit = async () => {
    if (!sessionId) {
      alert('Ошибка: нет сессии. Пожалуйста, войдите в систему.');
      console.warn('Ошибка: нет сессии. Пожалуйста, войдите в систему.');
      return;
    }

    try {
      const now = new Date();
      const currentDate = now.toISOString().split('T')[0];
      const changes: Array<{
        serviceName: string;
        clientId: string;
        clientName: string;
        serviceId: string;
        targetCount: number;
        originalCount: number;
      }> = [];

      uniqueServices.forEach(service => {
        clients.forEach(client => {
          const originalValue = originalVisits.get(service.name)?.get(client.id) || 0;
          const currentValue = getEditableVisitsCount(service.name, client.id);
          if (currentValue !== originalValue) {
            const serviceId = getSelectedServiceId(service.name, client.id);
            if (serviceId) {
              changes.push({
                serviceName: service.name,
                clientId: client.id,
                clientName: client.fullName,
                serviceId: serviceId,
                targetCount: currentValue,
                originalCount: originalValue
              });
            }
          }
        });
      });

      if (changes.length === 0) {
        alert('Нет изменений для отправки.');
        return;
      }
     

      setIsSubmitting(true);
      setHasConfirmedRefresh(false);
      setProgress({
        total: changes.length,
        completed: 0,
        failed: 0,
        currentOperation: 'Инициализация...',
        operations: changes.map((change, index) => ({
          id: `${change.clientId}_${change.serviceId}_${index}`,
          type: change.targetCount >= change.originalCount ? 'create' : 'delete',
          serviceName: change.serviceName,
          clientName: change.clientName,
          clientId: change.clientId,
          serviceId: change.serviceId,
          targetCount: change.targetCount,
          originalCount: change.originalCount,
          observedCount: change.originalCount,
          status: 'pending'
        }))
      });
      const result = await executeReliableSubmission({
        api: apiService,
        sessionId,
        date: currentDate,
        changes,
        onOperationUpdate: (index, patch) => {
          setProgress((prev) => {
            const nextOps = [...prev.operations];
            nextOps[index] = { ...nextOps[index], ...patch };
            const completed = nextOps.filter((op) =>
              op.status === 'verifiedSuccess' ||
              op.status === 'verifiedMismatch' ||
              op.status === 'error'
            ).length;
            return {
              ...prev,
              completed,
              failed: calcFailedCount(nextOps),
              operations: nextOps
            };
          });
        },
        onProgressMessage: (message) => {
          setProgress((prev) => ({ ...prev, currentOperation: message }));
        }
      });

      if (result.verifiedSuccess > 0) {
        try {
          setProgress(prev => ({ ...prev, currentOperation: 'Обновление данных...' }));
          const refreshedServices = await apiService.getAllClientsServices(sessionId);

          const {
            uniqueServices: refreshedUniqueServices,
            editableVisits: refreshedEditableVisits,
            originalVisits: refreshedOriginalVisits,
            serviceIdMap: refreshedServiceIdMap
          } = buildVisitsState(refreshedServices, clients);

          setUniqueServices(refreshedUniqueServices);
          setEditableVisits(refreshedEditableVisits);
          setOriginalVisits(refreshedOriginalVisits);
          setServiceIdMap(refreshedServiceIdMap);
          setHasConfirmedRefresh(true);

          if (result.failed === 0 && result.unknown === 0) {
            setProgress(prev => ({ ...prev, currentOperation: '✅ Услуги успешно обновлены' }));
          }
        } catch (refreshError) {
          console.error('⚠️ Failed to refresh services after submission:', refreshError);
          setProgress(prev => ({ ...prev, currentOperation: '⚠️ Не удалось подтвердить данные с сервера' }));
        }
      } else {
        setProgress(prev => ({
          ...prev,
          currentOperation: '⚠️ Нет подтвержденных операций. Проверьте расхождения и повторите.'
        }));
      }

    } catch (error) {
      console.error('Ошибка при отправке данных:', error);
      setIsSubmitting(false);
      alert('Ошибка при отправке данных. Попробуйте еще раз.');
    }
  };

  const allOperationsCompleted = progress.total > 0 && progress.completed === progress.total;

  const handleRetryFailed = async () => {
    if (!sessionId) {
      alert('Ошибка: нет сессии. Пожалуйста, войдите в систему.');
      return;
    }

    if (isRetrying) {
      return;
    }

    const failedOperations = progress.operations.filter(
      op => op.status === 'verifiedMismatch' || op.status === 'unknown' || op.status === 'error'
    );
    
    if (failedOperations.length === 0) {
      alert('Нет неудачных операций для переотправки.');
      return;
    }

    setIsRetrying(true);
    setHasConfirmedRefresh(false);

    try {
      const now = new Date();
      const currentDate = now.toISOString().split('T')[0];
      const retryChanges = failedOperations.map((op) => ({
        serviceName: op.serviceName,
        clientId: op.clientId,
        clientName: op.clientName,
        serviceId: op.serviceId,
        targetCount: op.targetCount,
        originalCount: op.originalCount
      }));

      const result = await executeReliableSubmission({
        api: apiService,
        sessionId,
        date: currentDate,
        changes: retryChanges,
        onProgressMessage: (message) => setProgress((prev) => ({ ...prev, currentOperation: message })),
        onOperationUpdate: (_index, _patch) => {}
      });

      setProgress((prev) => ({
        ...prev,
        operations: prev.operations.map((oldOp) => {
          const updated = result.operations.find((nextOp) =>
            nextOp.clientId === oldOp.clientId &&
            nextOp.serviceId === oldOp.serviceId &&
            nextOp.serviceName === oldOp.serviceName
          );
          return updated ? { ...oldOp, ...updated } : oldOp;
        }),
        failed: calcFailedCount(result.operations),
        currentOperation: `Переотправка завершена. Подтверждено: ${result.verifiedSuccess}, Ошибок: ${result.failed}`
      }));

      if (result.verifiedSuccess > 0) {
        try {
          setProgress(prev => ({ ...prev, currentOperation: 'Обновление данных...' }));
          const refreshedServices = await apiService.getAllClientsServices(sessionId);

          const {
            uniqueServices: refreshedUniqueServices,
            editableVisits: refreshedEditableVisits,
            originalVisits: refreshedOriginalVisits,
            serviceIdMap: refreshedServiceIdMap
          } = buildVisitsState(refreshedServices, clients);

          setUniqueServices(refreshedUniqueServices);
          setEditableVisits(refreshedEditableVisits);
          setOriginalVisits(refreshedOriginalVisits);
          setServiceIdMap(refreshedServiceIdMap);
          setHasConfirmedRefresh(true);

          if (result.failed === 0 && result.unknown === 0) {
            setProgress(prev => ({ ...prev, currentOperation: '✅ Услуги успешно обновлены' }));
          }
        } catch (refreshError) {
          console.error('⚠️ Failed to refresh services after retry:', refreshError);
        }
      }
    } finally {
      setIsRetrying(false);
    }
  };

  const handleExportXlsx = async () => {
    if (isExporting) {
      return;
    }

    try {
      setIsExporting(true);

      const servicesForExport = uniqueServices.map((service) => ({
        name: service.name,
        visitsByClientId: editableVisits.get(service.name) || new Map<string, number>()
      }));

      const result = await exportReportToXlsx({
        socialWorker,
        organization,
        period,
        clients,
        services: servicesForExport
      });

      if (result.exportedRows === 0) {
        alert('Нет заполненных услуг для экспорта. Проверьте, что в таблице есть значения больше 0.');
        console.info('Нет заполненных услуг для экспорта. Проверьте, что в таблице есть значения больше 0.');
        return;
      }
      console.info(`Экспорт завершен: ${result.fileName}`);
    } catch (error) {
      console.error('Ошибка экспорта в Excel:', error);
      alert('Не удалось экспортировать файл Excel. Попробуйте еще раз.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="report-container">
      {/* Модальное окно прогресса */}
      {isSubmitting && (
        <div className="progress-modal-overlay">
          <div className="progress-modal">
            <button
              type="button"
              className="progress-modal-close"
              onClick={() => setIsSubmitting(false)}
              disabled={!allOperationsCompleted}
              aria-label="Закрыть"
            >
              ×
            </button>
            <h2 className="progress-modal-title">Отправка данных на сервер</h2>
            
            <div className="progress-info">
              <p className="progress-current-operation">{progress.currentOperation}</p>
              <p className="progress-stats">
                Выполнено: {progress.completed} из {progress.total}
                {progress.failed > 0 && <span className="progress-failed"> (Ошибок: {progress.failed})</span>}
              </p>
              {allOperationsCompleted && progress.failed > 0 && (
                <div className="progress-retry-container">
                  <button
                    type="button"
                    className="progress-retry-button"
                    onClick={handleRetryFailed}
                    disabled={isRetrying}
                  >
                    {isRetrying ? '🔄 Переотправка...' : `🔄 Переотправить неудачные (${progress.failed})`}
                  </button>
                </div>
              )}
              {allOperationsCompleted && progress.failed === 0 && progress.total > 0 && hasConfirmedRefresh && (
                <div className="progress-retry-container">
                  <button
                    type="button"
                    className="progress-retry-button progress-ok-button"
                    onClick={() => setIsSubmitting(false)}
                  >
                    Ок
                  </button>
                </div>
              )}
            </div>

            <div className="progress-bar-container">
              <div 
                className="progress-bar-fill"
                style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
              />
            </div>

            <div className="progress-details">
              <table className="progress-operations-table">
                <thead>
                  <tr>
                    <th>ФИО клиента</th>
                    <th>Наименование услуги</th>
                    <th>Тип операции</th>
                    <th>Прогресс</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {getGroupedOperations().map((group, index) => (
                    <tr key={index} className="progress-operation-row">
                      <td>{formatClientNameShort(group.clientName)}</td>
                      <td>{group.serviceName}</td>
                      <td>{group.type === 'create' ? 'Добавление' : 'Удаление'}</td>
                      <td className={group.successful < group.total ? 'progress-count-error' : ''}>
                        {group.successful}/{group.total}
                      </td>
                      <td className="progress-status-cell">
                        {getOperationStatus(group)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="report-header" ref={reportHeaderRef}>
        <h1>Отчет по оказанным услугам и фактической загрузке</h1>
        <div className="report-info">
          <p><strong>Социальный работник:</strong> {socialWorker}</p>
          {organization && <p><strong>Организация:</strong> {organization}</p>}
          {period.start && period.end && (
            <p><strong>Период:</strong> с {period.start} по {period.end}</p>
          )}
          <p><strong>Всего клиентов:</strong> {clients.length}</p>
          <p><strong>Всего услуг:</strong> {getTotalVisitsCount()}</p>
          {Object.keys(serviceTariffs).length > 0 && (
            <p>
              <strong>Общая стоимость услуг:</strong>{' '}
              {formatRublesHuman(
                computeGrandTotalRub(
                  uniqueServices.map((u) => u.name),
                  clients.map((c) => c.id),
                  getEditableVisitsCount,
                  serviceTariffs
                )
              )}
            </p>
          )}
        </div>
        <div className="report-header-actions">
          <button
            type="button"
            className="export-btn"
            onClick={handleExportXlsx}
            disabled={isExporting || loading}
          >
            {isExporting ? 'Экспорт...' : 'Экспорт в Excel'}
          </button>
        </div>
      </div>

      <div className="table-wrapper">
        <table className="services-table">
          <thead>
            <tr>
              <th className="service-col">
                <div className="service-filter-wrapper">
                  <span>Наименование услуги</span>
                  <div className="service-filter-input-wrapper">
                    <input
                      type="text"
                      className="service-filter-input"
                      placeholder="Фильтр..."
                      value={serviceFilter}
                      onChange={(e) => setServiceFilter(e.target.value)}
                    />
                    {serviceFilter && (
                      <button
                        type="button"
                        className="service-filter-clear"
                        onClick={() => setServiceFilter('')}
                        aria-label="Очистить фильтр"
                      >
                        x
                      </button>
                    )}
                  </div>
                </div>
              </th>
              {clients.map((client) => {
                const servicesCount = getClientServicesCount(client.id);
                const fullNameParts = client.fullName.split(' ');
                const serviceNamesList = uniqueServices.map((u) => u.name);
                const clientRubLine = Object.keys(serviceTariffs).length > 0
                  ? formatRublesHuman(
                      computeClientTotalRub(
                        client.id,
                        serviceNamesList,
                        getEditableVisitsCount,
                        serviceTariffs
                      )
                    )
                  : null;
                return (
                  <th
                    key={client.id}
                    className="client-col"
                    data-client-id={client.id}
                  >
                    {fullNameParts.map((part, index) => (
                      <span key={index}>
                        {part}
                        {index < fullNameParts.length - 1 && <br />}
                      </span>
                    ))}
                    <br />
                    <span className="client-col-units">{servicesCount} услуг</span>
                    {clientRubLine && (
                      <>
                        <br />
                        <span className="client-col-rub">{clientRubLine}</span>
                      </>
                    )}
                  </th>
                );
              })}
              <th className="summary-col">Количество услуг</th>
            </tr>
          </thead>
          <tbody>
            {filteredServices.map(service => {
              const stats = getServiceStats(service.name);
              return (
                <tr key={service.name}>
                  <td className="service-name">
                    {service.name}
                    {Object.prototype.hasOwnProperty.call(serviceTariffs, service.name) && (
                        <>
                          {', '}
                          {serviceTariffs[service.name].toLocaleString('ru-RU', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2
                          })}
                          ₽
                        </>
                      )}
                  </td>
                  {clients.map(client => {
                    const visits = getEditableVisitsCount(service.name, client.id);
                    const changed = hasChanged(service.name, client.id);
                    // Проверяем, есть ли услуга у клиента через маппинг
                    const serviceId = getSelectedServiceId(service.name, client.id);
                    const hasService = !!serviceId;
                    
                    return (
                      <td 
                        key={client.id} 
                        className={`service-cell ${changed ? 'service-cell-changed' : ''} ${!hasService ? 'service-cell-disabled' : ''}`}
                        data-client-id={client.id}
                        onMouseEnter={(e) => {
                          const clientId = e.currentTarget.dataset.clientId;
                          if (clientId) {
                            const headerCell = document.querySelector(`th.client-col[data-client-id="${clientId}"]`);
                            if (headerCell) {
                              headerCell.classList.add('client-col-hovered');
                            }
                          }
                        }}
                        onMouseLeave={(e) => {
                          const clientId = e.currentTarget.dataset.clientId;
                          if (clientId) {
                            const headerCell = document.querySelector(`th.client-col[data-client-id="${clientId}"]`);
                            if (headerCell) {
                              headerCell.classList.remove('client-col-hovered');
                            }
                          }
                        }}
                      >
                        <div className="visits-input-wrapper">
                          <button
                            type="button"
                            className="visits-input-button visits-input-button-decrease"
                            onClick={() => {
                              const currentValue = getEditableVisitsCount(service.name, client.id);
                              updateVisitsCount(service.name, client.id, Math.max(0, currentValue - 1));
                            }}
                            aria-label="Уменьшить значение"
                            disabled={!hasService}
                          >
                            −
                          </button>
                          <input
                            type="number"
                            min="0"
                            max="999"
                            value={visits || ''}
                            onChange={(e) => {
                              // Фильтруем только цифры из введенного значения
                              const filteredValue = e.target.value.replace(/\D/g, '');
                              const value = filteredValue ? parseInt(filteredValue, 10) : 0;
                              updateVisitsCount(service.name, client.id, value);
                            }}
                            onKeyDown={handleKeyDown}
                            onPaste={handlePaste}
                            data-service-name={service.name}
                            data-client-id={client.id}
                            className="visits-input"
                            disabled={!hasService}
                          />
                          <button
                            type="button"
                            className="visits-input-button visits-input-button-increase"
                            onClick={() => {
                              const currentValue = getEditableVisitsCount(service.name, client.id);
                              updateVisitsCount(service.name, client.id, Math.min(999, currentValue + 1));
                            }}
                            aria-label="Увеличить значение"
                            disabled={!hasService}
                          >
                            +
                          </button>
                        </div>
                      </td>
                    );
                  })}
                  <td className="summary-cell">{stats.totalVisits}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="report-actions">
        <button 
          onClick={handleSubmit}
          className="submit-btn"
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Отправка...' : 'Отправить данные'}
        </button>
      </div>
    </div>
  );
};

export default ServicesTable;


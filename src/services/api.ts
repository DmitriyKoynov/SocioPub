import type { Service, Client, ReportData, ServiceWithVisits } from '../types';
import type { ApiService } from './apiContract';
import { fakeApiService } from './fakeApi';

// Базовый URL API
// В режиме разработки используется прокси Vite для обхода CORS
// В продакшене нужно будет использовать полный URL или настроить CORS на сервере
const API_BASE_URL = '/api';
const APEX_APP_ID = import.meta.env.VITE_APEX_APP_ID || '';
if (import.meta.env.VITE_API_MODE === 'real' && !/^\d+$/.test(APEX_APP_ID)) {
  throw new Error('Set VITE_APEX_APP_ID to the numeric Oracle APEX application ID.');
}

// Mock данные для разработки
const mockServices: Service[] = [
  {
    id: '1',
    name: 'Тестовая услуга 1',
    code: 'СБ 1.1',
    timeMinutes: 50,
    volumeTerms: '2 р/н'
  },
  {
    id: '2',
    name: 'Тестовая услуга 2',
    code: 'СБ 1.2',
    timeMinutes: 60,
    volumeTerms: '1 р/н'
  },
  {
    id: '3',
    name: 'Тестовая услуга 3',
    code: 'СБ 1.3',
    timeMinutes: 40,
    volumeTerms: '5 р/н'
  },
  {
    id: '4',
    name: 'Тестовая услуга 4',
    code: 'СБ 1.4',
    timeMinutes: 45,
    volumeTerms: '5 р/н'
  },
  {
    id: '5',
    name: 'Тестовая услуга 5',
    code: 'СБ 2.1',
    timeMinutes: 30,
    volumeTerms: '1 р/м'
  }
];

const mockClients: Client[] = [
  { id: '1', fullName: 'Тестовый клиент 1' },
  { id: '2', fullName: 'Тестовый клиент 2' },
  { id: '3', fullName: 'Тестовый клиент 3' },
  { id: '4', fullName: 'Тестовый клиент 4' },
  { id: '5', fullName: 'Тестовый клиент 5' },

];

// Функция для генерации случайного числа оказаний услуг (для демонстрации)
const generateRandomData = (): Array<{ serviceId: string; clientId: string; count: number }> => {
  const data: Array<{ serviceId: string; clientId: string; count: number }> = [];
  
  mockServices.forEach(service => {
    mockClients.forEach(client => {
      // Вероятность 30% что услуга была оказана
      if (Math.random() > 0.7) {
        data.push({
          serviceId: service.id,
          clientId: client.id,
          count: Math.floor(Math.random() * 8) + 1
        });
      }
    });
  });
  
  return data;
};

// Вспомогательная функция для декодирования HTML entities
const decodeHtml = (text: string): string => {
  return text
    .replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
      const code = parseInt(hex, 16);
      return Number.isNaN(code) ? match : String.fromCharCode(code);
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      const code = parseInt(dec, 10);
      return Number.isNaN(code) ? match : String.fromCharCode(code);
    });
};

// API функции (сейчас с mock данными, при подключении к реальному API раскомментировать)
const consolidationLocks = new Map<string, Promise<ServiceWithVisits[]>>();

// Кеш для параметров страницы 4: ключ = clientId_serviceId_sessionId
const page4ParamsCache = new Map<string, {
  salt: string;
  protected: string;
  pInstance: string;
  pPageSubmissionId: string;
  codSsd: string;
  codSorg: string;
  codPo: string;
  pageUrl: string;
  timestamp: number;
}>();

// Время жизни кеша: 30 секунд
const PAGE4_PARAMS_CACHE_TTL = 30000;
const REQUEST_TIMEOUT_MS = 15000;

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

const realApiService: ApiService = {
  // Авторизация
  async login(username: string, password: string): Promise<{ success: boolean; token?: string; sessionId?: string; error?: string; htmlResponse?: string }> {
    try {
      // Проверка входных данных
      if (!username || !password) {
        return { success: false, error: 'Введите имя пользователя и пароль' };
      }

      // Шаг 1: Получаем страницу логина для извлечения всех необходимых параметров
      let pInstance = '';
      let pPageSubmissionId = '';
      let salt = '';
      let protectedValue = '';
      
      try {
        const loginPageResponse = await fetch(`${API_BASE_URL}/f?p=${APEX_APP_ID}:LOGIN_JQM_SMARTPHONE`, {
          method: 'GET',
          credentials: 'include'
        });
        
        const loginPageHtml = await loginPageResponse.text();
        
        // Извлекаем session ID из финального URL после редиректов
        const finalUrl = loginPageResponse.url;
        
        // Из URL вида f?p=${APEX_APP_ID}:LOGIN_JQM_SMARTPHONE:<session-id>:::::
        // или f?p=${APEX_APP_ID}:101:<session-id>:::::
        const urlSessionMatch = finalUrl.match(/:(\d+):/g);
        if (urlSessionMatch && urlSessionMatch.length >= 2) {
          // Session извлекается из URL только для отладки, в работе используем pInstance.
        }
        
        // Извлекаем все необходимые параметры из HTML
        const instanceMatch = loginPageHtml.match(/name="p_instance"\s+value="([^"]*)"/i);
        const submissionIdMatch = loginPageHtml.match(/name="p_page_submission_id"\s+value="([^"]+)"/i);
        const saltMatch = loginPageHtml.match(/id="pSalt"\s+value="([^"]+)"/i);
        
        // Для protected ищем в специальном скрытом поле
        const protectedMatch = loginPageHtml.match(/id="pPageItemsProtected"\s+value="([^"]+)"/i);
        
        if (instanceMatch) {
          pInstance = instanceMatch[1];
        }
        
        if (submissionIdMatch) {
          pPageSubmissionId = submissionIdMatch[1];
        }
        
        if (saltMatch) {
          salt = saltMatch[1];
        } else {
          // Часто salt = p_page_submission_id
          salt = pPageSubmissionId;
        }
        
        if (protectedMatch) {
          protectedValue = protectedMatch[1];
        } else {
          console.warn('⚠️ protected value not found');
        }
        
        if (!pInstance || !pPageSubmissionId) {
          console.error('❌ Missing required parameters (p_instance or p_page_submission_id)');
          return { success: false, error: 'Не удалось получить параметры сессии' };
        }
        
      } catch (e) {
        console.error('❌ Initial page load failed:', e);
        return { success: false, error: 'Не удалось подключиться к серверу' };
      }

      // Шаг 2: Формируем JSON данные как в реальном запросе
      const pageItemsJson = {
        salt: salt,
        pageItems: {
          itemsToSubmit: [
            { n: 'P101_USERNAME', v: username },
            { n: 'P101_PASSWORD', v: password }
          ],
          protected: protectedValue,
          rowVersion: ''
        }
      };
      
      // Формируем данные для Oracle APEX в формате application/x-www-form-urlencoded
      const formData = new URLSearchParams();
      formData.append('p_json', JSON.stringify(pageItemsJson));
      formData.append('p_flow_id', APEX_APP_ID);
      formData.append('p_flow_step_id', '101');
      formData.append('p_instance', pInstance);
      formData.append('p_page_submission_id', pPageSubmissionId);
      formData.append('p_request', 'LOGIN');
      formData.append('p_reload_on_submit', 'A');

      const response = await fetch(`${API_BASE_URL}/wwv_flow.accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/html, */*; q=0.01'
        },
        body: formData.toString(),
        credentials: 'include', // Важно для работы с cookies
        redirect: 'manual' // НЕ следуем за редиректом автоматически, обрабатываем вручную
      });

      // Проверяем статус 302 (редирект) или 0 (opaque redirect при redirect: manual)
      if (response.status === 302 || response.status === 0 || response.type === 'opaqueredirect') {
        // Проверяем, действительно ли авторизация прошла успешно
        // Делаем тестовый запрос к главной странице для верификации
        let verifyText = '';
        try {
          const verifyResponse = await fetch(`${API_BASE_URL}/f?p=${APEX_APP_ID}:1:${pInstance}`, {
            method: 'GET',
            credentials: 'include',
            redirect: 'manual'
          });
          
          verifyText = await verifyResponse.text();
          
          // Если нас снова редиректит на логин - значит авторизация не прошла
          if (verifyResponse.status === 0 || 
              verifyText.includes('LOGIN') || 
              verifyText.includes('Авторизация') ||
              verifyText.includes('P101_USERNAME')) {
            return { success: false, error: 'Неверное имя пользователя или пароль' };
          }
          
          // Сохраняем HTML ответ от верификации для последующего использования в getClients
          // Это позволит избежать лишнего запроса
          if (typeof window !== 'undefined' && verifyText && verifyText.trim()) {
            try {
              sessionStorage.setItem(`login_html_${pInstance}`, verifyText);
            } catch (e) {
              console.warn('⚠️ Could not save HTML response:', e);
            }
          }
        } catch (verifyError) {
          console.warn('⚠️ Could not verify login, assuming success:', verifyError);
        }
        
        // При redirect: 'manual' браузер не дает доступ к Location заголовку
        // Но cookies уже установлены! Просто используем p_instance как session ID
        const sessionId = pInstance;
        
        if (typeof document !== 'undefined') {
          document.cookie = `LOGIN_USERNAME_COOKIE=${username}; path=/; SameSite=Lax`;
        }
        
        return { 
          success: true, 
          token: sessionId,
          sessionId,
          htmlResponse: verifyText && verifyText.trim() ? verifyText : undefined // Возвращаем HTML ответ если есть и не пустой
        };
      }

      // Если не редирект, получаем текст ответа для анализа
      const responseText = await response.text();

      // Oracle APEX может возвращать 200 с JavaScript редиректом
      // Проверяем несколько вариантов успешной авторизации:
      
      // Вариант 1: Прямой редирект (если каким-то образом response.redirected = true)
      if (response.redirected && response.url.includes(':1:')) {
        const urlParams = new URL(response.url).searchParams;
        const pValue = urlParams.get('p');
        let sessionId = '';
        
        if (pValue) {
          const parts = pValue.split(':');
          if (parts.length >= 3) {
            sessionId = parts[2];
          }
        }
        
        if (typeof document !== 'undefined') {
          document.cookie = `LOGIN_USERNAME_COOKIE=${username}; path=/; SameSite=Lax`;
        }
        
        return { 
          success: true, 
          token: sessionId,
          sessionId 
        };
      }
      
      // Вариант 2: HTML содержит редирект или успешный вход
      // Проверяем Location в ответе или JavaScript редирект
      const locationMatch = responseText.match(/location\.href\s*=\s*["']([^"']+)["']/i) ||
                           responseText.match(/window\.location\s*=\s*["']([^"']+)["']/i);
      
      if (locationMatch) {
        const redirectUrl = locationMatch[1];
        
        if (redirectUrl.includes(':1:')) {
          // Извлекаем session ID из редиректа
          const sessionMatch = redirectUrl.match(/:(\d+):/g);
          const sessionId = sessionMatch && sessionMatch.length > 1 
            ? sessionMatch[1].replace(/:/g, '') 
            : '';
          
          if (typeof document !== 'undefined') {
            document.cookie = `LOGIN_USERNAME_COOKIE=${username}; path=/; SameSite=Lax`;
          }
          
          return { 
            success: true, 
            token: sessionId,
            sessionId 
          };
        }
      }
      
      // Вариант 3: Проверяем текст на наличие ошибок
      if (responseText.includes('Your session has expired') || 
          responseText.includes('session has expired')) {
        console.error('❌ Session expired during login');
        return { success: false, error: 'Ошибка сессии. Попробуйте еще раз' };
      }
      
      if (responseText.includes('Invalid Login Credentials') || 
          responseText.includes('неверны') ||
          responseText.includes('неверные учетные данные')) {
        return { success: false, error: 'Неверное имя пользователя или пароль' };
      }
      
      // Проверяем, что не вернулась страница логина снова
      if (responseText.includes('LOGIN_JQM_SMARTPHONE') || 
          responseText.includes('Авторизация')) {
        return { success: false, error: 'Неверное имя пользователя или пароль' };
      }
      
      // Проверяем статус ответа для явных ошибок
      if (response.status === 401 || response.status === 403) {
        return { success: false, error: 'Неверное имя пользователя или пароль' };
      } else if (response.status >= 500) {
        return { success: false, error: 'Ошибка сервера. Попробуйте позже' };
      }
      
      // Если дошли сюда - непонятный ответ
      console.warn('Unexpected response format. Status 200 but no redirect found.');
      console.warn('Full response text:', responseText);
      return { success: false, error: 'Неверное имя пользователя или пароль' };
      
    } catch (error) {
      console.error('Login error:', error);
      
      // Более детальная информация об ошибке
      if (error instanceof TypeError && error.message.includes('fetch')) {
        return { success: false, error: 'Ошибка сети. Проверьте подключение' };
      }
      
      return { success: false, error: 'Произошла ошибка. Попробуйте позже' };
    }
  },

  // Получение списка услуг
  async getServices(): Promise<Service[]> {
    // TODO: Подключить реальный API
    // const response = await fetch(`${API_BASE_URL}/api/services`, {
    //   headers: { 'Authorization': `Bearer ${token}` }
    // });
    // return response.json();
    
    return Promise.resolve(mockServices);
  },

  // Парсинг HTML ответа для извлечения услуг с посещениями
  parseServicesFromHtml(html: string): ServiceWithVisits[] {
    const services: ServiceWithVisits[] = [];
    
    // Декодируем HTML entities
    let decodedHtml = html;
    
    // Декодируем hex entities &#x...;
    decodedHtml = decodedHtml.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
      try {
        const code = parseInt(hex, 16);
        return String.fromCharCode(code);
      } catch (e) {
        return match;
      }
    });
    
    // Декодируем числовые entities &#...;
    decodedHtml = decodedHtml.replace(/&#(\d+);/g, (match, dec) => {
      try {
        const code = parseInt(dec, 10);
        return String.fromCharCode(code);
      } catch (e) {
        return match;
      }
    });

    // Ищем все строки таблицы с услугами
    // Структура: <tr> с <td>, где первая <td> содержит ссылку с P3_COD_WSD
    const tableRowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    let match;
    
    while ((match = tableRowRegex.exec(decodedHtml)) !== null) {
      const rowHtml = match[0];
      
      // Проверяем, что это строка с услугой (содержит P3_COD_WSD)
      if (!rowHtml.includes('P3_COD_WSD')) {
        continue;
      }
      
      // Извлекаем ID услуги из href ссылки: P3_COD_WSD:ID
      const idMatch = rowHtml.match(/P3_COD_WSD[:=](\d+)/i);
      if (!idMatch) {
        continue;
      }
      const serviceId = idMatch[1];
      
      // Извлекаем название услуги из текста ссылки <a>...</a>
      // Нужно учитывать, что внутри <a> могут быть HTML entities и вложенные теги
      const linkMatch = rowHtml.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) {
        continue;
      }
      let serviceName = linkMatch[1].trim();
      // Убираем все HTML теги из названия (на случай вложенных тегов)
      serviceName = serviceName.replace(/<[^>]+>/g, '').trim();
      // Декодируем название если нужно (для HTML entities)
      serviceName = this.decodeHtmlEntities(serviceName);
      
      // Извлекаем все ячейки <td> из строки
      // Используем более сложный regex для извлечения <td> с учетом вложенных тегов
      const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const tdMatches: string[] = [];
      let tdMatch;
      while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
        tdMatches.push(tdMatch[1]);
      }
      
      if (!tdMatches || tdMatches.length < 3) {
        continue;
      }
      
      // Третья ячейка содержит количество посещений (колонка "Посещений (всего)")
      // Извлекаем число из третьей ячейки - убираем все HTML теги и берем первое число
      const visitsTd = tdMatches[2]; // Индекс 2 = третья колонка (0, 1, 2)
      // Убираем все HTML теги и находим число
      const cleanVisitsTd = visitsTd.replace(/<[^>]+>/g, '').trim();
      const visitsMatch = cleanVisitsTd.match(/^(\d+)/);
      const visits = visitsMatch ? parseInt(visitsMatch[1], 10) : 0;
      
      services.push({
        id: serviceId,
        name: serviceName,
        visits: visits
      });
    }
    
    return services;
  },

  // Получение доступных услуг для клиента с количеством посещений
  // ВАЖНО: Запрос выполняется каждый раз при вызове (без кеширования)
  async getAvailableServices(clientCodPerson: string, sessionId?: string): Promise<ServiceWithVisits[]> {
    try {
      // Если нет sessionId, возвращаем пустой массив
      if (!sessionId) {
        console.warn('⚠️ No sessionId, returning empty array');
        return Promise.resolve([]);
      }

      // Формируем URL согласно примеру запроса
      // GET f?p=${APEX_APP_ID}:2:<session-id>::NO:RP,2:P2_CODPERSON:<client-id>
      const url = `${API_BASE_URL}/f?p=${APEX_APP_ID}:2:${sessionId}::NO:RP,2:P2_CODPERSON:${clientCodPerson}`;

      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/html, */*; q=0.01',
          'Referer': `${API_BASE_URL}/f?p=${APEX_APP_ID}:1:${sessionId}:::::`,
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 9; SM-S908E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.70 Safari/537.36'
        },
        credentials: 'include'
      });

      // Проверяем, что получили успешный ответ
      if (!response.ok) {
        // Если это редирект на страницу логина, сессия истекла
        if (response.url && response.url.includes('LOGIN_JQM_SMARTPHONE')) {
          console.warn('⚠️ Redirected to login page - session expired');
          throw new Error('Session expired');
        }
        console.error('❌ Unexpected response status:', response.status);
        throw new Error(`Failed to fetch available services: ${response.status}`);
      }

      const html = await response.text();
      
      // Проверяем, не редиректнуло ли нас на страницу логина
      if (html.includes('LOGIN_JQM_SMARTPHONE') || html.includes('Авторизация') || html.includes('P101_USERNAME')) {
        console.warn('⚠️ Redirected to login page - session expired');
        throw new Error('Session expired');
      }

      // Парсим HTML чтобы извлечь доступные услуги с посещениями
      const services = this.parseServicesFromHtml(html);

      if (services.length === 0) {
        console.warn('⚠️ No services found in HTML');
        return [];
      }

      // Сортируем услуги по названию
      services.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

      // НЕ сохраняем в кеш - данные запрашиваются каждый раз при рендере компонента
      return services;
      
    } catch (error) {
      console.error('❌ Error fetching available services:', error);
      return [];
    }
  },

  // Получение списка ID посещений (P4_COD_JV) для услуги клиента
  // Это нужно для удаления записей - получаем со страницы 3 (детализация услуги)
  // clientId может использоваться для валидации, что посещения относятся к правильному клиенту
  async getVisitIds(_clientId: string, serviceId: string, sessionId?: string): Promise<string[]> {
    if (!sessionId) {
      return [];
    }

    try {
      // Запрашиваем страницу 3 (детализация услуги) для получения списка посещений
      // Формат: f?p=${APEX_APP_ID}:3:sessionId::NO:RP,3:P3_COD_WSD:serviceId
      const url = `${API_BASE_URL}/f?p=${APEX_APP_ID}:3:${sessionId}::NO:RP,3:P3_COD_WSD:${serviceId}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/html, */*; q=0.01',
          'Referer': `${API_BASE_URL}/f?p=${APEX_APP_ID}:2:${sessionId}:::::`,
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 9; SM-S908E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.70 Safari/537.36'
        },
        credentials: 'include'
      });

      if (!response.ok) {
        console.error('❌ Failed to fetch visit IDs:', response.status);
        return [];
      }

      const html = await response.text();
      
      // Декодируем HTML entities
      let decodedHtml = html;
      decodedHtml = decodedHtml.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
        try {
          const code = parseInt(hex, 16);
          return String.fromCharCode(code);
        } catch (e) {
          return match;
        }
      });
      decodedHtml = decodedHtml.replace(/&#(\d+);/g, (match, dec) => {
        try {
          const code = parseInt(dec, 10);
          return String.fromCharCode(code);
        } catch (e) {
          return match;
        }
      });

      // Ищем все ссылки с P4_COD_JV (ID посещения) на странице 3
      // Формат ссылки: f?p=${APEX_APP_ID}:4:...:P4_COD_JV:visitId
      const visitIdRegex = /P4_COD_JV[:=](\d+)/gi;
      const visitIds: string[] = [];
      let match;
      
      while ((match = visitIdRegex.exec(decodedHtml)) !== null) {
        const visitId = match[1];
        if (!visitIds.includes(visitId)) {
          visitIds.push(visitId);
        }
      }

      return visitIds;
    } catch (error) {
      console.error('❌ Error fetching visit IDs:', error);
      return [];
    }
  },

  async getServiceVisitCount(clientId: string, serviceId: string, sessionId?: string): Promise<number> {
    const visitIds = await this.getVisitIds(clientId, serviceId, sessionId);
    return visitIds.length;
  },

  // Получение параметров страницы 4 для конкретного клиента и услуги
  // Возвращает также необходимые параметры P4_COD_SSD, P4_COD_SORG, P4_COD_PO
  async getPage4Params(clientId: string, serviceId: string, sessionId?: string, useCache: boolean = true): Promise<{
    salt: string;
    protected: string;
    pInstance: string;
    pPageSubmissionId: string;
    codSsd: string;
    codSorg: string;
    codPo: string;
    pageUrl: string;
  } | null> {
    if (!sessionId) {
      return null;
    }

    const cacheKey = `${clientId}_${serviceId}_${sessionId}`;
    
    if (useCache) {
      const cached = page4ParamsCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < PAGE4_PARAMS_CACHE_TTL) {
        return {
          salt: cached.salt,
          protected: cached.protected,
          pInstance: cached.pInstance,
          pPageSubmissionId: cached.pPageSubmissionId,
          codSsd: cached.codSsd,
          codSorg: cached.codSorg,
          codPo: cached.codPo,
          pageUrl: cached.pageUrl
        };
      }
    }

    try {
      // Сначала нужно получить P4_COD_SSD, P4_COD_SORG, P4_COD_PO со страницы 2 (список услуг клиента)
      // Они должны быть в HTML страницы 2 для этой услуги
      // Попробуем получить их из страницы 2 сначала
      
      // Переходим на страницу 2 (список услуг клиента) чтобы получить нужные параметры
      const page2Url = `${API_BASE_URL}/f?p=${APEX_APP_ID}:2:${sessionId}::NO:RP,2:P2_CODPERSON:${clientId}`;
      
      const page2Response = await fetchWithTimeout(page2Url, {
        method: 'GET',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/html, */*; q=0.01',
          'Referer': `${API_BASE_URL}/f?p=${APEX_APP_ID}:1:${sessionId}:::::`,
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 9; SM-S908E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.70 Safari/537.36'
        },
        credentials: 'include'
      });

      let codSsd = '';
      let codSorg = '';
      let codPo = '';
      let page2Html = '';
      let decodedPage2Html = '';
      let fullPage4UrlFromPage3 = ''; // Сохраняем полный URL со страницы 3 с checksum

      if (page2Response.ok) {
        page2Html = await page2Response.text();
        decodedPage2Html = decodeHtml(page2Html);

        // Ищем ссылку на услугу с нужным serviceId (P3_COD_WSD)
        // В этой ссылке могут быть дополнительные параметры P4_COD_SSD, P4_COD_SORG
        // Формат ссылки: f?p=${APEX_APP_ID}:3:...:P3_COD_WSD:serviceId или f?p=${APEX_APP_ID}:4:...:P4_COD_PERSON,P4_COD_SSD,P4_COD_WSD,P4_COD_SORG:...
        const serviceLinkRegex = new RegExp(`(f\\?p=${APEX_APP_ID}:[34]:[^"'>]*P[34]_COD_WSD[:=]${serviceId}[^"'>]*["'])`, 'i');
        const serviceLinkMatch = decodedPage2Html.match(serviceLinkRegex);
        
        if (serviceLinkMatch) {
          const link = serviceLinkMatch[1];
          
          // Пытаемся извлечь параметры из ссылки на страницу 4
          // Формат: f?p=${APEX_APP_ID}:4:...:P4_COD_PERSON,P4_COD_SSD,P4_COD_WSD,P4_COD_SORG:clientId,ssd,serviceId,sorg&cs=...
          if (link.includes('P4_COD_PERSON') && link.includes('P4_COD_SSD') && link.includes('P4_COD_SORG')) {
            // Извлекаем параметры, обрезая до & или до конца ссылки
            const paramsMatch = link.match(/P4_COD_PERSON,P4_COD_SSD,P4_COD_WSD,P4_COD_SORG:([^:&"']+)/i);
            if (paramsMatch) {
              // Убираем &cs=... если есть, и декодируем \u0026 в &
              let paramsStr = paramsMatch[1].replace(/\\u0026.*$/, '').replace(/&.*$/, '').replace(/\\u0026/g, '&');
              const params = paramsStr.split(',');
              if (params.length >= 4) {
                // Проверяем, что третий параметр соответствует serviceId
                if (params[2] === serviceId) {
                  codSsd = params[1]; // Второй параметр - SSD
                  codSorg = params[3]; // Четвертый параметр - SORG (уже обрезан от &cs)
                }
              }
            }
          }
        }

        // Также ищем в ссылках на страницу 3 (детализация услуги)
        // На странице 3 может быть информация о ссылке на страницу 4
        const page3LinkRegex = new RegExp(`(f\\?p=${APEX_APP_ID}:3:[^"'>]*P3_COD_WSD[:=]${serviceId}[^"'>]*["'])`, 'i');
        decodedPage2Html.match(page3LinkRegex);
      }

      // Переходим на страницу 4 с параметрами клиента и услуги
      // Согласно примеру: f?p=${APEX_APP_ID}:4:sessionId::NO:RP,4:P4_COD_PERSON,P4_COD_SSD,P4_COD_WSD,P4_COD_SORG:clientId,ssd,wsd,sorg
      // Но нам нужно сначала получить ssd и sorg
      // Попробуем сначала перейти на страницу 3 (детализация услуги), где могут быть эти параметры
      
      // ВАРИАНТ 1: Переходим на страницу 3 чтобы получить параметры, затем на 4
      const page3Url = `${API_BASE_URL}/f?p=${APEX_APP_ID}:3:${sessionId}::NO:RP,3:P3_COD_WSD:${serviceId}`;
      
      const page3Response = await fetchWithTimeout(page3Url, {
        method: 'GET',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/html, */*; q=0.01',
          'Referer': `${API_BASE_URL}/f?p=${APEX_APP_ID}:2:${sessionId}:::::`,
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 9; SM-S908E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.70 Safari/537.36'
        },
        credentials: 'include'
      });

      // Сохраняем HTML страницы 3 для извлечения полного URL
      let page3HtmlRaw = '';
      
      if (page3Response.ok) {
        page3HtmlRaw = await page3Response.text(); // Сохраняем исходный HTML для поиска checksum
        const decodedPage3Html = decodeHtml(page3HtmlRaw);

        // Ищем ссылки на страницу 4 на странице 3
        // Формат: f?p=${APEX_APP_ID}:4:...:P4_COD_PERSON,P4_COD_SSD,P4_COD_WSD,P4_COD_SORG:clientId,ssd,serviceId,sorg&cs=...
        // ВАЖНО: Нужно сохранить полный URL со checksum!
        const page4LinkRegex = new RegExp(`(f\\?p=${APEX_APP_ID}:4:[^"'>]*P4_COD_PERSON,P4_COD_SSD,P4_COD_WSD,P4_COD_SORG:[^"'>]*["'])`, 'i');
        const page4LinkMatch = decodedPage3Html.match(page4LinkRegex);
        
        if (page4LinkMatch) {
          let link = page4LinkMatch[1];
          // Убираем закрывающую кавычку если есть
          link = link.replace(/["']$/, '');
          
          // Также ищем полную ссылку с checksum в исходном HTML (без декодирования)
          // Нужно найти ссылку, которая содержит &cs= или \u0026cs=
          if (page3HtmlRaw) {
            const fullLinkMatch = page3HtmlRaw.match(new RegExp(`(f\\?p=${APEX_APP_ID}:4:[^"'>]*P4_COD_PERSON[^"'>]*(?:&|\\\\u0026)cs=[^"'>]*["'])`, 'i'));
          if (fullLinkMatch) {
            let fullLink = fullLinkMatch[1].replace(/["']$/, '');
            // Декодируем \u0026 в &
            fullLink = fullLink.replace(/\\u0026/g, '&');
              fullPage4UrlFromPage3 = fullLink;
            }
          }
          
          // Извлекаем параметры из ссылки
          // Формат: f?p=${APEX_APP_ID}:4:...:P4_COD_PERSON,P4_COD_SSD,P4_COD_WSD,P4_COD_SORG:clientId,ssd,serviceId,sorg&cs=...
          const paramsMatch = link.match(/P4_COD_PERSON,P4_COD_SSD,P4_COD_WSD,P4_COD_SORG:([^:&"']+)/i);
          if (paramsMatch) {
            // Убираем &cs=... если есть, и декодируем \u0026 в &
            let paramsStr = paramsMatch[1].replace(/\\u0026.*$/, '').replace(/&.*$/, '').replace(/\\u0026/g, '&');
            const params = paramsStr.split(',');
            if (params.length >= 4) {
              // Проверяем, что третий параметр соответствует serviceId, а первый - clientId
              if (params[0] === clientId && params[2] === serviceId) {
                if (!codSsd) codSsd = params[1]; // Второй параметр - SSD
                if (!codSorg) codSorg = params[3]; // Четвертый параметр - SORG (уже обрезан от &cs)
              }
            }
          }
        }

        // Также ищем параметры в других местах на странице 3
        // Ищем в прямых упоминаниях P4_COD_SSD, P4_COD_SORG, P4_COD_PO
        if (!codSsd) {
          const ssdMatch = decodedPage3Html.match(/P4_COD_SSD[:=](\d+)/i);
          if (ssdMatch) codSsd = ssdMatch[1];
        }
        if (!codSorg) {
          const sorgMatch = decodedPage3Html.match(/P4_COD_SORG[:=](\d+)/i);
          if (sorgMatch) codSorg = sorgMatch[1];
        }
        if (!codPo) {
          const poMatch = decodedPage3Html.match(/P4_COD_PO[:=](\d+)/i);
          if (poMatch) codPo = poMatch[1];
        }
      }

      // Если не получили все параметры, пробуем получить их из страницы 2 (список услуг)
      // На странице 2 может быть информация о P2_CODPO (исполнитель), который соответствует P4_COD_PO
      if (!codPo && decodedPage2Html) {

        // Ищем P1_CODPO (исполнитель) на странице 2
        // Вариант 1: <select id="P1_CODPO">...<option value="ID" selected>...</option>
        const codpoSelectRegex = /<select[^>]*id=["']P1_CODPO["'][^>]*>([\s\S]*?)<\/select>/i;
        const codpoSelectMatch = decodedPage2Html.match(codpoSelectRegex);
        if (codpoSelectMatch) {
          const selectedOptionRegex = /<option[^>]*selected[^>]*value=["'](\d+)["']/i;
          const selectedMatch = codpoSelectMatch[1].match(selectedOptionRegex);
          if (selectedMatch) {
            codPo = selectedMatch[1];
          }
        }

        // Вариант 2: скрытое поле <input type="hidden" name="P1_CODPO" value="...">
        if (!codPo) {
          const codpoInputMatch = decodedPage2Html.match(/name=["']P1_CODPO["'][^>]*value=["'](\d+)["']/i) ||
                                  decodedPage2Html.match(/id=["']P1_CODPO["'][^>]*value=["'](\d+)["']/i);
          if (codpoInputMatch) {
            codPo = codpoInputMatch[1];
          }
        }

        // Вариант 3: значение в JavaScript переменной или data-атрибуте
        if (!codPo) {
          const codpoJsMatch = decodedPage2Html.match(/P1_CODPO["'\s:=]+(\d+)/i);
          if (codpoJsMatch) {
            codPo = codpoJsMatch[1];
          }
        }
      }

      codSsd = codSsd.trim();
      codSorg = codSorg.trim();
      codPo = codPo.trim();

      // Формируем URL для страницы 4
      // КРИТИЧНО: Если нашли полный URL со страницы 3 (с checksum), используем его!
      // Без checksum Oracle APEX вернет ошибку "Session state protection violation"
      let page4Url: string;
      
      if (fullPage4UrlFromPage3) {
        // Используем полный URL со страницы 3, который уже содержит checksum
        page4Url = `${API_BASE_URL}/${fullPage4UrlFromPage3}`;
      } else {
        // Запасной вариант: формируем URL самостоятельно (но это может не работать без checksum)
        console.warn('⚠️ No full page 4 URL found on page 3, constructing URL manually (may fail without checksum)');
        const encodeParams = (values: string[]) => values.map(value => encodeURIComponent(value)).join(',');
        
        if (codSsd && codSorg) {
          page4Url = `${API_BASE_URL}/f?p=${APEX_APP_ID}:4:${sessionId}::NO:RP,4:P4_COD_PERSON,P4_COD_SSD,P4_COD_WSD,P4_COD_SORG:${encodeParams([clientId, codSsd, serviceId, codSorg])}`;
        } else if (codSsd) {
          page4Url = `${API_BASE_URL}/f?p=${APEX_APP_ID}:4:${sessionId}::NO:RP,4:P4_COD_PERSON,P4_COD_SSD,P4_COD_WSD:${encodeParams([clientId, codSsd, serviceId])}`;
        } else {
          page4Url = `${API_BASE_URL}/f?p=${APEX_APP_ID}:4:${sessionId}::NO:RP,4:P4_COD_PERSON,P4_COD_WSD:${encodeParams([clientId, serviceId])}`;
        }
      }

      const response = await fetchWithTimeout(page4Url, {
        method: 'GET',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/html, */*; q=0.01',
          'Referer': `${API_BASE_URL}/f?p=${APEX_APP_ID}:2:${sessionId}:::::`,
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 9; SM-S908E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.70 Safari/537.36'
        },
        credentials: 'include'
      });

      if (!response.ok) {
        console.error('❌ Failed to fetch page 4 params:', response.status);
        const errorText = await response.text();
        console.error('❌ Response text:', errorText.substring(0, 500));
        return null;
      }

      const html = await response.text();

      const decodedHtml = decodeHtml(html);

      // Извлекаем параметры из HTML (пробуем несколько вариантов)
      // Ищем salt (может быть в скрытом поле или как значение p_page_submission_id)
      let saltMatch = html.match(/id=["']pSalt["'][^>]*value=["']([^"]+)["']/i) ||
                     decodedHtml.match(/id=["']pSalt["'][^>]*value=["']([^"]+)["']/i) ||
                     html.match(/id="pSalt"\s+value="([^"]+)"/i) ||
                     decodedHtml.match(/id="pSalt"\s+value="([^"]+)"/i);

      // Ищем protected (pPageItemsProtected)
      // Может быть в разных форматах: id, name, или в JSON
      // В примерах успешных запросов protected имеет формат типа "6UA-V4LbhAA4mXp2SVQwmw" или "KMVxhGK0cmY-z67Vyvb1Kw"
      let protectedMatch = html.match(/id=["']pPageItemsProtected["'][^>]*value=["']([^"]+)["']/i) ||
                          decodedHtml.match(/id=["']pPageItemsProtected["'][^>]*value=["']([^"]+)["']/i) ||
                          html.match(/name=["']pPageItemsProtected["'][^>]*value=["']([^"]+)["']/i) ||
                          decodedHtml.match(/name=["']pPageItemsProtected["'][^>]*value=["']([^"]+)["']/i) ||
                          html.match(/id="pPageItemsProtected"\s+value="([^"]+)"/i) ||
                          decodedHtml.match(/id="pPageItemsProtected"\s+value="([^"]+)"/i) ||
                          html.match(/name="pPageItemsProtected"\s+value="([^"]+)"/i) ||
                          decodedHtml.match(/name="pPageItemsProtected"\s+value="([^"]+)"/i) ||
                          // Также ищем в JSON структуре в HTML (может быть внутри <script>)
                          html.match(/"protected"\s*:\s*"([^"\\s]{10,})"/i) ||
                          decodedHtml.match(/"protected"\s*:\s*"([^"\\s]{10,})"/i) ||
                          // Ищем в любом месте HTML как значение protected с алфавитно-цифровыми символами и дефисами
                          html.match(/protected["'\s:=]+["']([A-Za-z0-9_-]{10,})["']/i) ||
                          decodedHtml.match(/protected["'\s:=]+["']([A-Za-z0-9_-]{10,})["']/i) ||
                          // Более общий поиск - ищем любую строку вида "XXXX-XXXX" которая может быть protected
                          html.match(/pPageItemsProtected[^>]*value\s*=\s*["']([A-Za-z0-9_-]{10,})["']/i) ||
                          decodedHtml.match(/pPageItemsProtected[^>]*value\s*=\s*["']([A-Za-z0-9_-]{10,})["']/i);

      // Ищем p_instance
      let instanceMatch = html.match(/name=["']p_instance["'][^>]*value=["']([^"]*)["']/i) ||
                          decodedHtml.match(/name=["']p_instance["'][^>]*value=["']([^"]*)["']/i) ||
                          html.match(/name="p_instance"[^>]*value="([^"]*)"/i) ||
                          decodedHtml.match(/name="p_instance"[^>]*value="([^"]*)"/i);

      // Ищем p_page_submission_id
      let submissionIdMatch = html.match(/name=["']p_page_submission_id["'][^>]*value=["']([^"]+)["']/i) ||
                              decodedHtml.match(/name=["']p_page_submission_id["'][^>]*value=["']([^"]+)["']/i) ||
                              html.match(/name="p_page_submission_id"[^>]*value="([^"]+)"/i) ||
                              decodedHtml.match(/name="p_page_submission_id"[^>]*value="([^"]+)"/i) ||
                              html.match(/id="pPageSubmissionId"[^>]*value="([^"]+)"/i) ||
                              decodedHtml.match(/id="pPageSubmissionId"[^>]*value="([^"]+)"/i);

      // Ищем P4_* значения в скрытых полях страницы 4
      const codSsdMatchPage4 = html.match(/name=["']P4_COD_SSD["'][^>]*value=["']([^"]*)["']/i) ||
                                decodedHtml.match(/name=["']P4_COD_SSD["'][^>]*value=["']([^"]*)["']/i) ||
                                html.match(/id=["']P4_COD_SSD["'][^>]*value=["']([^"]*)["']/i) ||
                                decodedHtml.match(/id=["']P4_COD_SSD["'][^>]*value=["']([^"]*)["']/i);
      if (codSsdMatchPage4 && !codSsd) {
        codSsd = codSsdMatchPage4[1].trim();
      }

      const codSorgMatchPage4 = html.match(/name=["']P4_COD_SORG["'][^>]*value=["']([^"]*)["']/i) ||
                                 decodedHtml.match(/name=["']P4_COD_SORG["'][^>]*value=["']([^"]*)["']/i) ||
                                 html.match(/id=["']P4_COD_SORG["'][^>]*value=["']([^"]*)["']/i) ||
                                 decodedHtml.match(/id=["']P4_COD_SORG["'][^>]*value=["']([^"]*)["']/i);
      if (codSorgMatchPage4 && !codSorg) {
        codSorg = codSorgMatchPage4[1].trim();
      }

      const codPoMatch = html.match(/name=["']P4_COD_PO["'][^>]*value=["']([^"]*)["']/i) ||
                         decodedHtml.match(/name=["']P4_COD_PO["'][^>]*value=["']([^"]*)["']/i) ||
                         html.match(/id=["']P4_COD_PO["'][^>]*value=["']([^"]*)["']/i) ||
                         decodedHtml.match(/id=["']P4_COD_PO["'][^>]*value=["']([^"]*)["']/i) ||
                         html.match(/name="P4_COD_PO"[^>]*value="([^"]*)"/i) ||
                         decodedHtml.match(/name="P4_COD_PO"[^>]*value="([^"]*)"/i);

      if (codPoMatch && !codPo) {
        codPo = codPoMatch[1].trim();
      }

      const salt = saltMatch ? saltMatch[1] : '';
      let protectedValue = protectedMatch ? protectedMatch[1] : '';
      const pInstance = instanceMatch ? instanceMatch[1] : sessionId;
      const pPageSubmissionId = submissionIdMatch ? submissionIdMatch[1] : '';

      // В примере успешного запроса salt совпадает с p_page_submission_id
      // Если salt не найден, используем p_page_submission_id как salt
      // Если salt найден, но не совпадает с p_page_submission_id, используем p_page_submission_id
      const finalSalt = pPageSubmissionId || salt;
      
      // Важно: salt и p_page_submission_id должны совпадать для успешного запроса
      if (salt && pPageSubmissionId && salt !== pPageSubmissionId) {
        console.warn('⚠️ salt and p_page_submission_id differ, using p_page_submission_id for salt');
      }

      const sanitizedSalt = finalSalt.trim();
      // Используем найденное значение protected, обрезая пробелы
      // Будет обновлено ниже после агрессивного поиска, если нужно
      let sanitizedProtected = protectedValue ? protectedValue.trim() : '';
      const sanitizedInstance = (pInstance || sessionId).trim();
      const sanitizedSubmissionId = pPageSubmissionId.trim();
      const sanitizedCodSsd = codSsd.trim();
      const sanitizedCodSorg = codSorg.trim();
      const sanitizedCodPo = codPo.trim();

      // Если protected не найден, пытаемся найти его более агрессивно
      if (!sanitizedProtected) {
        console.warn('⚠️ protected not found, trying more aggressive search...');
        // Ищем в скриптах на странице - логируем ВСЕ скрипты
        const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
        if (scriptMatches) {
          console.warn(`📄 Found ${scriptMatches.length} <script> tags, searching for protected...`);
          scriptMatches.forEach((script, idx) => {
            console.warn(`📄 Script ${idx + 1} (first 500 chars):`, script.substring(0, 500));
            const protectedInScript = script.match(/"protected"\s*:\s*"([^"\\s]{10,})"/i) ||
                                      script.match(/protected["'\s:=]+["']([A-Za-z0-9_-]{10,})["']/i) ||
                                      script.match(/pPageItemsProtected[^>]*value\s*=\s*["']([^"']{10,})["']/i) ||
                                      script.match(/["']protected["']\s*:\s*["']([^"']{10,})["']/i);
            if (protectedInScript && protectedInScript[1]) {
              console.error(`✅ Found protected in script ${idx + 1}:`, protectedInScript[1]);
              // Обновляем protectedValue для использования найденного значения
              protectedValue = protectedInScript[1];
            }
          });
        } else {
          console.warn('⚠️ No <script> tags found in HTML');
        }
        
        // Если все еще не найден, логируем HTML для отладки
        if (!protectedValue || protectedValue.trim().length === 0) {
          console.warn('⚠️ protected still not found after aggressive search');
          // Выводим часть HTML где могут быть параметры (форма и скрытые поля)
          const formMatch = decodedHtml.match(/<form[^>]*>([\s\S]{0,3000})<\/form>/i);
          if (formMatch) {
            console.warn('📄 Form HTML preview (first 1500 chars):', formMatch[1].substring(0, 1500));
          }
          
          // Также ищем все скрытые поля - логируем ПОЛНОСТЬЮ
          const hiddenInputs = decodedHtml.match(/<input[^>]*type=["']hidden["'][^>]*>/gi);
          if (hiddenInputs) {
            console.warn('📄 Hidden inputs found:', hiddenInputs.length);
            hiddenInputs.forEach((input, i) => {
              console.warn(`  Input ${i + 1} (FULL):`, input);
              // Особое внимание к полям с "protected" в названии или id
              if (input.toLowerCase().includes('protected')) {
                console.error(`  ⚠️ FOUND PROTECTED-RELATED INPUT ${i + 1}:`, input);
              }
            });
          }
          
          // Ищем ВСЕ поля, которые могут содержать protected (не только hidden)
          const allInputsWithProtected = decodedHtml.match(/<input[^>]*(?:id|name)=["'][^"']*protected[^"']*["'][^>]*>/gi);
          if (allInputsWithProtected && allInputsWithProtected.length > 0) {
            console.error('🔍 Found inputs with "protected" in id/name:', allInputsWithProtected.length);
            allInputsWithProtected.forEach((input, i) => {
              console.error(`  Protected Input ${i + 1}:`, input);
            });
          }
        }
      }

      // Обновляем sanitizedProtected с учетом агрессивного поиска (если был)
      if (protectedValue && protectedValue.trim().length > 0) {
        sanitizedProtected = protectedValue.trim();
      }

      // Если salt и p_page_submission_id не найдены, выводим часть HTML для отладки
      if (!sanitizedSalt || !sanitizedSubmissionId) {
        console.warn('⚠️ Missing required params from page 4');
        // Выводим часть HTML где могут быть параметры (форма)
        const formMatch = decodedHtml.match(/<form[^>]*>([\s\S]{0,2000})<\/form>/i);
        if (formMatch) {
          console.warn('📄 Form HTML preview:', formMatch[1].substring(0, 1000));
        }
        return null;
      }

      const result = { 
        salt: sanitizedSalt, 
        protected: sanitizedProtected, // Может быть пустым, но попытаемся продолжить
        pInstance: sanitizedInstance, 
        pPageSubmissionId: sanitizedSubmissionId,
        codSsd: sanitizedCodSsd,
        codSorg: sanitizedCodSorg,
        codPo: sanitizedCodPo,
        pageUrl: page4Url // Используется для формирования Referer URL
      };

      if (useCache) {
        page4ParamsCache.set(cacheKey, {
          ...result,
          timestamp: Date.now()
        });
      }

      return result;
    } catch (error) {
      console.error('❌ Error fetching page 4 params:', error);
      return null;
    }
  },

  // Добавление услуги (CREATE)
  async createServiceVisit(params: {
    clientId: string;
    serviceId: string;
    sessionId: string;
    date: string; // YYYY-MM-DD
    hours?: number;
    minutes?: number;
  }): Promise<boolean> {
    const { clientId, serviceId, sessionId, date, hours = 0, minutes = 30 } = params;
    try {

      // Получаем параметры страницы 4 (включая codSsd, codSorg, codPo)
      // Используем кеш для оптимизации
      const pageParams = await this.getPage4Params(clientId, serviceId, sessionId, true);
      if (!pageParams) {
        console.error('❌ Failed to get page 4 params');
        return false;
      }

      // Используем параметры из getPage4Params
      const { codSsd, codSorg, codPo } = pageParams;

      const finalCodSsd = codSsd || '';
      const finalCodSorg = codSorg || '';
      const finalCodPo = codPo || '';

      // Проверяем наличие обязательных параметров
      // codPo может быть пустым - проверяем только codSsd и codSorg
      if (!finalCodSsd || !finalCodSorg) {
        console.error('❌ Missing required params:', { 
          codSsd: finalCodSsd, 
          codSorg: finalCodSorg, 
          codPo: finalCodPo 
        });
        return false;
      }

      // codPo может быть пустым - это не критично для CREATE
      if (!finalCodPo) {
        console.warn('⚠️ codPo is empty, continuing anyway');
      }

      // Формируем Referer URL перед использованием (как в примерах успешных запросов)
      // В примерах успешных запросов Referer имеет простой формат:
      // НЕ включаем дополнительные параметры RP,4:P4_COD_PERSON,...
      let refererUrl: string;
      if (API_BASE_URL.startsWith('http')) {
        // Используем простой формат как в примерах
        refererUrl = `${API_BASE_URL}/f?p=${APEX_APP_ID}:4:${pageParams.pInstance}::NO:::`;
      } else {
        // В режиме разработки через прокси формируем полный URL
        refererUrl = typeof window !== 'undefined'
          ? `${window.location.origin}${API_BASE_URL}/f?p=${APEX_APP_ID}:4:${pageParams.pInstance}::NO:::`
          : `${API_BASE_URL}/f?p=${APEX_APP_ID}:4:${pageParams.pInstance}::NO:::`;
      }

      // Формируем Origin (домен без пути)
      // В режиме разработки через прокси может быть localhost:5173, но сервер должен принимать это
      const originUrl = API_BASE_URL.startsWith('http') 
        ? API_BASE_URL.replace('/api', '')
        : (typeof window !== 'undefined' 
            ? window.location.origin
            : '');

      // Предупреждаем, если protected пустой - это может быть проблемой
      if (!pageParams.protected || pageParams.protected.trim().length === 0) {
        console.warn('⚠️ WARNING: protected is empty! This may cause the request to fail.');
        console.warn('   The server may require a protected value for CSRF protection.');
      }

      // Формируем JSON данные
      // В успешном запросе salt совпадает с p_page_submission_id
      // Используем p_page_submission_id как salt
      const saltToUse = pageParams.pPageSubmissionId || pageParams.salt;
      
      // Порядок полей должен соответствовать примерам успешных запросов:
      // P4_COD_JV (пустое), P4_COD_WSD, P4_COD_SSD, P4_COD_PERSON, P4_COD_SORG, P4_COD_PO,
      // P4_DATEVISIT_JV, P4_HOURS_JS, P4_MINUT_JS, P4_ORGANIZ (пустое)
      const pageItemsJson = {
        salt: saltToUse,
        pageItems: {
          itemsToSubmit: [
            { n: 'P4_COD_JV', v: '' }, // Пустое для CREATE
            { n: 'P4_COD_WSD', v: serviceId },
            { n: 'P4_COD_SSD', v: finalCodSsd },
            { n: 'P4_COD_PERSON', v: clientId },
            { n: 'P4_COD_SORG', v: finalCodSorg },
            { n: 'P4_COD_PO', v: finalCodPo },
            { n: 'P4_DATEVISIT_JV', v: date },
            { n: 'P4_HOURS_JS', v: String(hours) },
            { n: 'P4_MINUT_JS', v: String(minutes) },
            { n: 'P4_ORGANIZ', v: '' }
          ],
          protected: pageParams.protected,
          rowVersion: ''
        }
      };

      // Формируем данные для отправки
      // Важно: p_page_submission_id должен совпадать с salt в JSON
      const formData = new URLSearchParams();
      formData.append('p_json', JSON.stringify(pageItemsJson));
      formData.append('p_flow_id', APEX_APP_ID);
      formData.append('p_flow_step_id', '4');
      formData.append('p_instance', pageParams.pInstance);
      formData.append('p_page_submission_id', saltToUse); // Используем saltToUse, чтобы гарантировать совпадение
      formData.append('p_request', 'CREATE');
      formData.append('p_reload_on_submit', 'A');

      const response = await fetchWithTimeout(`${API_BASE_URL}/wwv_flow.accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/html, */*; q=0.01',
          'Origin': originUrl,
          'Referer': refererUrl,
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 9; SM-S908E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.70 Safari/537.36'
        },
        body: formData.toString(),
        credentials: 'include'
      });

      if (!response.ok) {
        console.error('❌ Failed to create service visit:', response.status);
        const errorText = await response.text();
        console.error('❌ Response text:', errorText.substring(0, 500));
        return false;
      }

      // Проверяем ответ - Oracle APEX может вернуть HTML страницу или JSON
      const responseText = await response.text();
      
      // Ищем признаки успешного или неуспешного ответа
      // Проверяем на наличие реальных ошибок в ответе
      // Ищем специфичные паттерны ошибок Oracle APEX
      const errorPatterns = [
        /ORA-\d{5}/i,  // Oracle error codes
        /SQL Error/i,
        /Fatal Error/i,
        /Application Error/i,
        /Internal Server Error/i,
        /"error":\s*true/i,  // JSON error flag
        /"status":\s*"error"/i  // JSON error status
      ];
      
      let hasError = false;
      for (const pattern of errorPatterns) {
        if (pattern.test(responseText)) {
          hasError = true;
          console.error('❌ Error pattern found in response:', pattern);
          break;
        }
      }

      if (hasError) {
        console.error('❌ Error in response:', responseText.substring(0, 500));
        return false;
      }

      // Успешный ответ может быть:
      // 1. HTML страница (редирект на страницу посещения) - нормально
      // 2. JSON с success
      // 3. Редирект (302)
      
      // Если это HTML страница с нормальным содержимым (не ошибка), считаем успехом
      if (responseText.includes('<!DOCTYPE html') || responseText.includes('<html')) {
        // Проверяем, что это не страница ошибки
        // Страница ошибки обычно содержит специфичные элементы
        if (!responseText.includes('Application Error') && 
            !responseText.includes('Internal Server Error') &&
            !responseText.includes('ORA-') &&
            responseText.length > 100) {
          // Инвалидируем кеш после успешной операции
          this.invalidatePage4Cache(clientId, serviceId, sessionId);
          return true;
        }
      }

      // Проверяем на успешный результат
      if (responseText.includes('success') || responseText.includes('SUCCESS') ||
          responseText.includes('Location:') || response.status === 302) {
        // Инвалидируем кеш после успешной операции
        this.invalidatePage4Cache(clientId, serviceId, sessionId);
        return true;
      }

      // Если ответ короткий и непонятный, это может быть ошибка
      if (responseText.length < 50) {
        console.warn('⚠️ Suspicious response length:', responseText.length);
        console.warn('⚠️ Response content:', responseText);
        return false;
      }

      // Если не нашли явных признаков успеха, считаем ошибкой
      console.error('❌ No success indicators found in response');
      console.error('❌ Response preview:', responseText.substring(0, 500));
      // Инвалидируем кеш после неуспешной операции
      this.invalidatePage4Cache(clientId, serviceId, sessionId);
      return false;
    } catch (error) {
      console.error('❌ Error creating service visit:', error);
      // Инвалидируем кеш после ошибки
      this.invalidatePage4Cache(clientId, serviceId, sessionId);
      return false;
    }
  },

  // Удаление услуги (DELETE)
  async deleteServiceVisit(params: {
    visitId: string; // P4_COD_JV
    clientId: string;
    serviceId: string;
    sessionId: string;
    date: string;
    hours?: number;
    minutes?: number;
  }): Promise<boolean> {
    const { visitId, clientId, serviceId, sessionId, date, hours = 0, minutes = 30 } = params;
    try {

      // Получаем параметры страницы 4
      // Используем кеш для оптимизации
      const pageParams = await this.getPage4Params(clientId, serviceId, sessionId, true);
      if (!pageParams) {
        console.error('❌ Failed to get page 4 params');
        return false;
      }

      // Получаем параметры со страницы 4 (нужно получить полный HTML для извлечения)
      // TODO: Получить P4_COD_SSD, P4_COD_SORG, P4_COD_PO, rowVersion из HTML страницы 4
      // Пока извлекаем из URL или используем значения по умолчанию
      // Для DELETE нужно получить rowVersion из существующей записи посещения
      
      // Запрашиваем страницу 4 с visitId для получения полных данных
      const page4Url = `${API_BASE_URL}/f?p=${APEX_APP_ID}:4:${sessionId}::NO:RP,4:P4_COD_JV:${visitId}`;
      const page4Response = await fetchWithTimeout(page4Url, {
        method: 'GET',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/html, */*; q=0.01',
          'Referer': `${API_BASE_URL}/f?p=${APEX_APP_ID}:3:${sessionId}:::::`,
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 9; SM-S908E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.70 Safari/537.36'
        },
        credentials: 'include'
      });

      let codSsd = '';
      let codSorg = '';
      let codPo = '';
      let rowVersion = '';

      if (page4Response.ok) {
        const page4Html = await page4Response.text();
        // Декодируем HTML entities
        let decodedPage4Html = page4Html;
        decodedPage4Html = decodedPage4Html.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
          try {
            return String.fromCharCode(parseInt(hex, 16));
          } catch (e) {
            return match;
          }
        });
        decodedPage4Html = decodedPage4Html.replace(/&#(\d+);/g, (match, dec) => {
          try {
            return String.fromCharCode(parseInt(dec, 10));
          } catch (e) {
            return match;
          }
        });

        // Извлекаем параметры из скрытых полей или input элементов
        // P4_COD_SSD
        const codSsdMatch = decodedPage4Html.match(/name=["']P4_COD_SSD["'][^>]*value=["']([^"]*)["']/i) ||
                          decodedPage4Html.match(/id=["']P4_COD_SSD["'][^>]*value=["']([^"]*)["']/i);
        if (codSsdMatch) codSsd = codSsdMatch[1];

        // P4_COD_SORG
        const codSorgMatch = decodedPage4Html.match(/name=["']P4_COD_SORG["'][^>]*value=["']([^"]*)["']/i) ||
                            decodedPage4Html.match(/id=["']P4_COD_SORG["'][^>]*value=["']([^"]*)["']/i);
        if (codSorgMatch) codSorg = codSorgMatch[1];

        // P4_COD_PO
        const codPoMatch = decodedPage4Html.match(/name=["']P4_COD_PO["'][^>]*value=["']([^"]*)["']/i) ||
                          decodedPage4Html.match(/id=["']P4_COD_PO["'][^>]*value=["']([^"]*)["']/i);
        if (codPoMatch) codPo = codPoMatch[1];

        // rowVersion
        const rowVersionMatch = decodedPage4Html.match(/id=["']pPageItemsRowVersion["'][^>]*value=["']([^"]*)["']/i);
        if (rowVersionMatch) rowVersion = rowVersionMatch[1];
      }

      // Формируем JSON данные
      const pageItemsJson = {
        salt: pageParams.salt,
        pageItems: {
          itemsToSubmit: [
            { n: 'P4_COD_JV', v: visitId },
            { n: 'P4_COD_WSD', v: serviceId },
            { n: 'P4_COD_SSD', v: codSsd },
            { n: 'P4_COD_PERSON', v: clientId },
            { n: 'P4_COD_SORG', v: codSorg },
            { n: 'P4_COD_PO', v: codPo },
            { n: 'P4_DATEVISIT_JV', v: date },
            { n: 'P4_HOURS_JS', v: String(hours) },
            { n: 'P4_MINUT_JS', v: String(minutes) },
            { n: 'P4_ORGANIZ', v: '' }
          ],
          protected: pageParams.protected,
          rowVersion: rowVersion
        }
      };

      // Формируем данные для отправки
      const formData = new URLSearchParams();
      formData.append('p_json', JSON.stringify(pageItemsJson));
      formData.append('p_flow_id', APEX_APP_ID);
      formData.append('p_flow_step_id', '4');
      formData.append('p_instance', pageParams.pInstance);
      formData.append('p_page_submission_id', pageParams.pPageSubmissionId);
      formData.append('p_request', 'DELETE');
      formData.append('p_reload_on_submit', 'A');

      const response = await fetchWithTimeout(`${API_BASE_URL}/wwv_flow.accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/html, */*; q=0.01',
          'Origin': API_BASE_URL.replace('/api', ''),
          'Referer': `${API_BASE_URL}/f?p=${APEX_APP_ID}:4:${sessionId}::NO:RP,4:P4_COD_JV:${visitId}`
        },
        body: formData.toString(),
        credentials: 'include'
      });

      if (!response.ok) {
        console.error('❌ Failed to delete service visit:', response.status);
        const errorText = await response.text();
        console.error('❌ Response text:', errorText.substring(0, 500));
        return false;
      }

      const responseText = await response.text();

      const errorPatterns = [
        /ORA-\d{5}/i,
        /SQL Error/i,
        /Fatal Error/i,
        /Application Error/i,
        /Internal Server Error/i,
        /"error":\s*true/i,
        /"status":\s*"error"/i,
        /Session state protection violation/i,
        /Invalid session/i
      ];

      let hasError = false;
      for (const pattern of errorPatterns) {
        if (pattern.test(responseText)) {
          hasError = true;
          console.error('❌ Error pattern found in delete response:', pattern);
          break;
        }
      }

      if (hasError) {
        console.error('❌ Error in delete response:', responseText.substring(0, 500));
        return false;
      }

      if (responseText.includes('<!DOCTYPE html') || responseText.includes('<html')) {
        if (!responseText.includes('Application Error') && 
            !responseText.includes('Internal Server Error') &&
            !responseText.includes('ORA-') &&
            responseText.length > 100) {
          return true;
        }
      }

      if (responseText.includes('success') || responseText.includes('SUCCESS') ||
          responseText.includes('Location:') || response.status === 302) {
        // Инвалидируем кеш после успешной операции
        this.invalidatePage4Cache(clientId, serviceId, sessionId);
        return true;
      }

      if (responseText.includes('<!DOCTYPE html') || responseText.includes('<html')) {
        if (!responseText.includes('Application Error') && 
            !responseText.includes('Internal Server Error') &&
            !responseText.includes('ORA-') &&
            responseText.length > 100) {
          // Инвалидируем кеш после успешной операции
          this.invalidatePage4Cache(clientId, serviceId, sessionId);
          return true;
        }
      }

      if (responseText.length < 50) {
        console.warn('⚠️ Suspicious delete response length:', responseText.length);
        console.warn('⚠️ Response content:', responseText);
        // Инвалидируем кеш после неуспешной операции
        this.invalidatePage4Cache(clientId, serviceId, sessionId);
        return false;
      }

      console.error('❌ No success indicators found in delete response');
      console.error('❌ Response preview:', responseText.substring(0, 500));
      // Инвалидируем кеш после неуспешной операции
      this.invalidatePage4Cache(clientId, serviceId, sessionId);
      return false;
    } catch (error) {
      console.error('❌ Error deleting service visit:', error);
      // Инвалидируем кеш после ошибки
      this.invalidatePage4Cache(clientId, serviceId, sessionId);
      return false;
    }
  },

  // Верификация создания записи - проверяет, что запись действительно создана
  async verifyServiceVisitCreated(
    clientId: string,
    serviceId: string,
    sessionId: string,
    expectedCount: number = 1
  ): Promise<boolean> {
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const visitIds = await this.getVisitIds(clientId, serviceId, sessionId);
      const actualCount = visitIds.length;
      
      if (actualCount >= expectedCount) {
        return true;
      }
      
      console.warn(`⚠️ Verification failed: expected at least ${expectedCount} visits, found ${actualCount}`);
      return false;
    } catch (error) {
      console.error('❌ Error verifying service visit creation:', error);
      return false;
    }
  },

  // Верификация удаления записи - проверяет, что запись действительно удалена
  async verifyServiceVisitDeleted(
    visitId: string,
    clientId: string,
    serviceId: string,
    sessionId: string
  ): Promise<boolean> {
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const visitIds = await this.getVisitIds(clientId, serviceId, sessionId);
      const stillExists = visitIds.includes(visitId);
      
      if (!stillExists) {
        return true;
      }
      
      console.warn(`⚠️ Verification failed: visit ${visitId} still exists after deletion`);
      return false;
    } catch (error) {
      console.error('❌ Error verifying service visit deletion:', error);
      return false;
    }
  },

  // Инвалидация кеша параметров страницы 4 для конкретного клиента и услуги
  invalidatePage4Cache(clientId: string, serviceId: string, sessionId: string): void {
    const cacheKey = `${clientId}_${serviceId}_${sessionId}`;
    page4ParamsCache.delete(cacheKey);
  },

  // Консолидация дублей услуг для клиента
  async consolidateServiceDuplicates(
    clientId: string,
    services: ServiceWithVisits[],
    sessionId: string
  ): Promise<ServiceWithVisits[]> {
    const lockKey = `${clientId}_${sessionId}`;
    
    if (consolidationLocks.has(lockKey)) {
      return await consolidationLocks.get(lockKey)!;
    }
    
    const consolidationPromise = (async (): Promise<ServiceWithVisits[]> => {
      try {
        const serviceGroups = new Map<string, ServiceWithVisits[]>();
        
        services.forEach(service => {
          const existing = serviceGroups.get(service.name) || [];
          existing.push(service);
          serviceGroups.set(service.name, existing);
        });
        
        const consolidatedServices: ServiceWithVisits[] = [];
        const now = new Date();
        const currentDate = now.toISOString().split('T')[0];
        
        for (const [, duplicates] of serviceGroups.entries()) {
          if (duplicates.length === 1) {
            consolidatedServices.push(duplicates[0]);
            continue;
          }
          
          const servicesWithVisits = duplicates.filter(s => s.visits > 0);
          const totalVisits = duplicates.reduce((sum, s) => sum + s.visits, 0);
          
          if (servicesWithVisits.length === 0) {
            const firstService = duplicates[0];
            consolidatedServices.push({ ...firstService, visits: 0 });
            continue;
          }
          
          if (servicesWithVisits.length === 1) {
            const selectedService = servicesWithVisits[0];
            consolidatedServices.push({ ...selectedService, visits: totalVisits });
            continue;
          }
          
          const selectedService = servicesWithVisits.reduce((max, s) => 
            s.visits > max.visits ? s : max
          );
          
          const otherServices = duplicates.filter(s => s.id !== selectedService.id);
          const otherServicesWithVisits = otherServices.filter(s => s.visits > 0);
          
          if (otherServicesWithVisits.length === 0) {
            consolidatedServices.push({
              ...selectedService,
              visits: totalVisits
            });
            continue;
          }
          
          const currentVisitIds = await this.getVisitIds(clientId, selectedService.id, sessionId);
          const currentVisitsInSelected = currentVisitIds.length;
          const recordsToCreate = (totalVisits - currentVisitsInSelected);
          
          for (const otherService of otherServicesWithVisits) {
            try {
              const visitIds = await this.getVisitIds(clientId, otherService.id, sessionId);
              
              if (visitIds.length === 0) {
                continue;
              }
              
              for (const visitId of visitIds) {
                try {
                  await this.deleteServiceVisit({
                    visitId,
                    clientId,
                    serviceId: otherService.id,
                    sessionId,
                    date: currentDate,
                    hours: 0,
                    minutes: 30
                  });
                  await new Promise(resolve => setTimeout(resolve, 100));
                } catch (error) {
                  console.error(`❌ Error deleting visit ${visitId} from duplicate service:`, error);
                }
              }
            } catch (error) {
              console.error(`❌ Error consolidating duplicate service ${otherService.id}:`, error);
            }
          }
          
          if (recordsToCreate > 0) {
            for (let i = 0; i < recordsToCreate; i++) {
              try {
                const created = await this.createServiceVisit({
                  clientId,
                  serviceId: selectedService.id,
                  sessionId,
                  date: currentDate,
                  hours: 0,
                  minutes: 30
                });
                if (created) {
                  await new Promise(resolve => setTimeout(resolve, 100));
                }
              } catch (error) {
                console.error(`❌ Error creating visit in primary service:`, error);
              }
            }
          } else if (recordsToCreate < 0) {
            console.warn(`⚠️ Selected service has more visits (${currentVisitsInSelected}) than expected total (${totalVisits})`);
          }
          
          consolidatedServices.push({
            ...selectedService,
            visits: totalVisits
          });
        }
        
        return consolidatedServices;
      } finally {
        consolidationLocks.delete(lockKey);
      }
    })();
    
    consolidationLocks.set(lockKey, consolidationPromise);
    return await consolidationPromise;
  },

  // Загрузка услуг для всех клиентов параллельно
  async getAllClientsServices(sessionId?: string): Promise<Map<string, ServiceWithVisits[]>> {
    // Получаем клиентов из localStorage
    const clientsCache = localStorage.getItem('clients_cache');
    if (!clientsCache) {
      console.warn('⚠️ No clients in localStorage');
      return new Map();
    }
    
    const clients: Client[] = JSON.parse(clientsCache);
    
    if (!sessionId) {
      console.warn('⚠️ No sessionId provided');
      return new Map();
    }
    
    // Загружаем услуги для всех клиентов параллельно
    const servicePromises = clients.map(async (client) => {
      try {
        const services = await this.getAvailableServices(client.id, sessionId);
        return { clientId: client.id, services };
      } catch (error) {
        console.error(`❌ Error loading services for client ${client.id}:`, error);
        return { clientId: client.id, services: [] };
      }
    });
    
    // Ждем завершения всех запросов
    const results = await Promise.all(servicePromises);
    
    // Создаем Map для удобного доступа
    const servicesMap = new Map<string, ServiceWithVisits[]>();
    results.forEach(({ clientId, services }) => {
      servicesMap.set(clientId, services);
    });
    
    return servicesMap;
  },

  // Функция для декодирования HTML-сущностей
  decodeHtmlEntities(text: string): string {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
  },

  // Получение списка клиентов сотрудника
  async getClients(sessionId?: string, forceRefresh: boolean = false, htmlResponse?: string): Promise<Client[]> {
    try {
      // Проверяем кеш СНАЧАЛА, если не принудительное обновление
      if (!forceRefresh) {
        const cachedData = localStorage.getItem('clients_cache');
        
        if (cachedData) {
          const clients = JSON.parse(cachedData) as Client[];
          return clients;
        }
      }

      // Если нет кеша и нет sessionId, используем mock данные
      if (!sessionId) {
        console.warn('⚠️ No sessionId and no cache, using mock data');
        return Promise.resolve(mockClients);
      }

      let html = htmlResponse && htmlResponse.trim() ? htmlResponse : undefined;

      // Проверяем, есть ли сохраненный HTML ответ от верификации в login
      if (!html && typeof window !== 'undefined') {
        try {
          const savedHtml = sessionStorage.getItem(`login_html_${sessionId}`);
          if (savedHtml && savedHtml.trim()) {
            html = savedHtml;
            // Удаляем из sessionStorage после использования
            sessionStorage.removeItem(`login_html_${sessionId}`);
          }
        } catch (e) {
          console.warn('⚠️ Could not read saved HTML response:', e);
        }
      }

      // Если нет сохраненного HTML, делаем новый запрос
      if (!html) {
        // Делаем запрос через прокси - прокси будет автоматически обрабатывать редиректы
        // НЕ используем redirect: 'manual', чтобы прокси мог обработать редиректы на серверной стороне
        let response = await fetch(`${API_BASE_URL}/f?p=${APEX_APP_ID}:1:${sessionId}::NO:::`, {
          method: 'GET',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'text/html, */*; q=0.01',
            'Referer': `${API_BASE_URL}/f?p=${APEX_APP_ID}:LOGIN_JQM_SMARTPHONE:${sessionId}::::::`
          },
          credentials: 'include'
          // Используем redirect: 'follow' по умолчанию - прокси будет обрабатывать редиректы
        });

        // Проверяем, что получили успешный ответ
        if (!response.ok) {
          // Если это редирект на страницу логина, сессия истекла
          if (response.url && response.url.includes('LOGIN_JQM_SMARTPHONE')) {
            console.warn('⚠️ Redirected to login page - session expired');
            throw new Error('Session expired');
          }
          console.error('❌ Unexpected response status:', response.status);
          throw new Error(`Failed to fetch clients: ${response.status}`);
        }

        html = await response.text();
      }
      
      // Проверяем, не редиректнуло ли нас на страницу логина
      if (html.includes('LOGIN_JQM_SMARTPHONE') || html.includes('Авторизация') || html.includes('P101_USERNAME')) {
        console.warn('⚠️ Redirected to login page - session expired');
        throw new Error('Session expired');
      }

      // Функция для преобразования имени из ВЕРХНЕГО РЕГИСТРА в нормальный формат
      const formatName = (name: string): string => {
        return name
          .split(' ')
          .map(word => {
            if (word.length === 0) return word;
            // Первая буква заглавная, остальные строчные
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
          })
          .join(' ');
      };

      // Парсим HTML чтобы извлечь имена клиентов
      // Клиенты находятся в таблице внутри <td> с ссылками <a>
      // Формат: <a href="f?p=${APEX_APP_ID}:2:...:P2_CODPERSON:ID">ИМЯ</a>
      // В HTML символы могут быть закодированы как HTML entities (&#x3A; вместо :, и т.д.)
      const clients: Client[] = [];
      
      // Подход: сначала декодируем HTML entities, затем используем простой regex
      // Декодируем HTML entities в строке для всех символов (включая русские буквы)
      let decodedHtml = html;
      
      // Декодируем hex entities &#x...;
      decodedHtml = decodedHtml.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => {
        try {
          const code = parseInt(hex, 16);
          return String.fromCharCode(code);
        } catch (e) {
          return match;
        }
      });
      
      // Декодируем числовые entities &#...;
      decodedHtml = decodedHtml.replace(/&#(\d+);/g, (match, dec) => {
        try {
          const code = parseInt(dec, 10);
          return String.fromCharCode(code);
        } catch (e) {
          return match;
        }
      });
      
      // Теперь ищем ссылки с P2_CODPERSON в декодированном HTML
      // Формат после декодирования: <a href="...P2_CODPERSON:ID">ИМЯ</a>
      // Используем более простой regex, так как HTML уже декодирован
      const clientLinkRegex = /<a[^>]*href\s*=\s*["'][^"']*P2_CODPERSON[:=](\d+)[^"']*["'][^>]*>([^<]+)<\/a>/gi;
      let match;
      
      while ((match = clientLinkRegex.exec(decodedHtml)) !== null) {
        const id = match[1];
        const name = match[2].trim();
        
        // Декодируем имя клиента еще раз (на случай если остались entities)
        const decodedName = this.decodeHtmlEntities(name);
        const fullName = formatName(decodedName);
        
        if (id && fullName && fullName.length > 0) {
          // Проверяем, не добавили ли мы уже этого клиента
          if (!clients.find(c => c.id === id)) {
            clients.push({ id, fullName });
          }
        }
      }
      
      // Если не нашли клиентов, пробуем альтернативный метод: ищем все ссылки и фильтруем по P2_CODPERSON
      if (clients.length === 0) {
        // Ищем все ссылки и проверяем их на наличие P2_CODPERSON
        const allLinksRegex = /<a[^>]*>([^<]+)<\/a>/gi;
        let linkCount = 0;
        
        while ((match = allLinksRegex.exec(decodedHtml)) !== null) {
          linkCount++;
          const fullTag = match[0];
          const name = match[1].trim();
          
          // Проверяем, содержит ли ссылка P2_CODPERSON
          if (fullTag.includes('P2_CODPERSON')) {
            // Извлекаем ID после P2_CODPERSON (может быть : или = после него)
            const idPattern = /P2_CODPERSON[:=](\d+)/i;
            const idResult = fullTag.match(idPattern);
            
            if (idResult && name.length > 5) {
              const id = idResult[1];
              const decodedName = this.decodeHtmlEntities(name);
              const fullName = formatName(decodedName);
              
              if (id && fullName && fullName.length > 0) {
                // Проверяем, не добавили ли мы уже этого клиента
                if (!clients.find(c => c.id === id)) {
                  clients.push({ id, fullName });
                }
              }
            }
          }
        }
      }

      // Ищем ФИО социального работника в select с id="P1_CODPO"
      // Формат: <select id="P1_CODPO">...<option value="ID" selected="selected">ФИО</option>...</select>
      let socialWorkerFullName = 'Неизвестно';
      
      // Сначала находим select с id="P1_CODPO"
      const codpoSelectRegex = /<select[^>]*id=["']P1_CODPO["'][^>]*>([\s\S]*?)<\/select>/i;
      const codpoSelectMatch = decodedHtml.match(codpoSelectRegex);
      
      if (codpoSelectMatch) {
        const selectContent = codpoSelectMatch[1];
        
        // Ищем option с selected="selected" внутри этого select
        const selectedOptionRegex = /<option[^>]*selected=["']selected["'][^>]*>([^<]+)<\/option>/i;
        const selectedOptionMatch = selectContent.match(selectedOptionRegex);
        
        if (selectedOptionMatch) {
          const encodedName = selectedOptionMatch[1].trim();
          
          // Декодируем HTML entities
          const decodedName = this.decodeHtmlEntities(encodedName);
          
          // Применяем форматирование имени (из ВЕРХНЕГО РЕГИСТРА в нормальный формат)
          if (decodedName && decodedName.length > 0) {
            socialWorkerFullName = formatName(decodedName);
          } else {
            console.warn('⚠️ Found selected option but name is empty');
          }
        } else {
          console.warn('⚠️ Select P1_CODPO found but no selected option inside');
        }
      } else {
        console.warn('⚠️ Select P1_CODPO not found in HTML');
      }

      // Сохраняем ФИО социального работника в localStorage
      try {
        localStorage.setItem('social_worker_name', socialWorkerFullName);
      } catch (e) {
        console.error('❌ Failed to cache social worker name:', e);
      }

      // Ищем организацию в HTML
      // Формат: <p class="organiz">Учреждение(я): название организации&nbsp;</p>
      let organizationName = '';
      
      const organizRegex = /<p[^>]*class=["']organiz["'][^>]*>Учреждение\(я\):\s*([^<&]+)/i;
      const organizMatch = decodedHtml.match(organizRegex);
      
      if (organizMatch) {
        organizationName = organizMatch[1].trim();
        // Убираем &nbsp; и другие HTML entities
        organizationName = this.decodeHtmlEntities(organizationName).replace(/&nbsp;/g, '').trim();
      } else {
        console.warn('⚠️ Organization not found in HTML');
      }
      
      // Сохраняем организацию в localStorage
      try {
        if (organizationName) {
          localStorage.setItem('organization_name', organizationName);
        }
      } catch (e) {
        console.error('❌ Failed to cache organization name:', e);
      }

      if (clients.length === 0) {
        console.warn('⚠️ No clients found in HTML, using mock data');
        return mockClients;
      }

      // Сортируем клиентов в алфавитном порядке по фамилии
      clients.sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));

      // Сохраняем в кеш (без timestamp - храним вечно до логаута)
      try {
        const cacheData = JSON.stringify(clients);
        localStorage.setItem('clients_cache', cacheData);
      } catch (e) {
        console.error('❌ Failed to cache clients:', e);
      }

      return clients;
      
    } catch (error) {
      console.error('❌ Error fetching clients:', error);
      console.warn('⚠️ Falling back to mock data');
      return mockClients;
    }
  },

  // Получение полного отчета
  async getReport(sessionId?: string): Promise<ReportData> {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    
    // Получаем реальных клиентов если есть sessionId
    const clients = sessionId 
      ? await this.getClients(sessionId)
      : mockClients;
    
    // Получаем ФИО социального работника из localStorage
    const socialWorkerName = localStorage.getItem('social_worker_name') || 'Неизвестно';
    
    return Promise.resolve({
      services: mockServices,
      clients: clients,
      serviceRendered: generateRandomData(),
      period: {
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0]
      },
      socialWorker: socialWorkerName,
      organization: localStorage.getItem('organization_name') || ''
    });
  }
};

const API_MODE = import.meta.env.VITE_API_MODE === 'real' ? 'real' : 'fake';
export const apiService: ApiService = API_MODE === 'real' ? realApiService : fakeApiService;


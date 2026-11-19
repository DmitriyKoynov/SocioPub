import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { apiService } from '../services/api';

interface AuthContextType {
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  username: string | null;
  sessionId: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  // Инициализируем состояние из localStorage
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return localStorage.getItem('isAuthenticated') === 'true';
  });
  const [username, setUsername] = useState<string | null>(() => {
    return localStorage.getItem('username');
  });
  const [sessionId, setSessionId] = useState<string | null>(() => {
    return localStorage.getItem('sessionId');
  });

  const login = async (username: string, password: string): Promise<boolean> => {
    const result = await apiService.login(username, password);
    if (result.success) {
      setIsAuthenticated(true);
      setUsername(username);
      setSessionId(result.sessionId || null);
      
      // Сохраняем данные в localStorage для восстановления сессии
      const loginTimestamp = Date.now().toString();
      localStorage.setItem('isAuthenticated', 'true');
      localStorage.setItem('username', username);
      localStorage.setItem('login_timestamp', loginTimestamp);
      if (result.sessionId) {
        localStorage.setItem('sessionId', result.sessionId);
      }
      
      // Сразу после авторизации запрашиваем список клиентов
      // forceRefresh = true чтобы всегда получать свежие данные при логине
      // Передаем htmlResponse из результата логина, чтобы избежать лишнего запроса
      if (result.sessionId) {
        try {
          await apiService.getClients(result.sessionId, true, result.htmlResponse);
        } catch (error) {
          console.error('❌ Error fetching clients after login:', error);
        }
      }
      
      return true;
    }
    return false;
  };

  const logout = () => {
    setIsAuthenticated(false);
    setUsername(null);
    setSessionId(null);
    
    // Очищаем localStorage
    localStorage.removeItem('isAuthenticated');
    localStorage.removeItem('username');
    localStorage.removeItem('sessionId');
    localStorage.removeItem('login_timestamp');
    
    // Очищаем кеш клиентов и работника
    localStorage.removeItem('clients_cache');
    localStorage.removeItem('social_worker_name');
    
    // Очищаем cookies для всех возможных путей
    const cookiesToClear = ['LOGIN_USERNAME_COOKIE'];
    if (import.meta.env.VITE_APEX_APP_ID) {
      cookiesToClear.push(`ORA_WWV_APP_${import.meta.env.VITE_APEX_APP_ID}`);
    }
    const paths = ['/', '/api', '/api/'];
    
    cookiesToClear.forEach(cookieName => {
      paths.forEach(path => {
        document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=${path};`;
        document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=${path}; domain=localhost;`;
      });
    });
  };

  // Проверяем валидность сохраненной сессии при загрузке
  useEffect(() => {
    const checkSession = async () => {
      const savedAuth = localStorage.getItem('isAuthenticated');
      const savedSessionId = localStorage.getItem('sessionId');
      const loginTimestamp = localStorage.getItem('login_timestamp');
      
      // Проверяем, не прошло ли 7 дней с момента логина
      if (savedAuth === 'true' && loginTimestamp) {
        const now = Date.now();
        const loginTime = parseInt(loginTimestamp, 10);
        const sevenDays = 7 * 24 * 60 * 60 * 1000; // 7 дней в миллисекундах
        
        if (now - loginTime > sevenDays) {
          logout();
          return;
        }
      }
      
      // Если есть сохраненная сессия, восстанавливаем её
      if (savedAuth === 'true' && savedSessionId) {
      } else if (savedAuth === 'true' && !savedSessionId) {
        // Если auth = true, но нет sessionId - очищаем
        logout();
      }
    };

    checkSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout, username, sessionId }}>
      {children}
    </AuthContext.Provider>
  );
};


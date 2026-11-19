import { useAuth } from './context/AuthContext';
import LoginModal from './components/LoginModal';
import ServicesTable from './components/ServicesTable';
import './App.css';

function App() {
  const { isAuthenticated, logout, username } = useAuth();

  return (
    <div className="app">
      {!isAuthenticated ? (
        <LoginModal />
      ) : (
        <div className="app-scroll-wrapper">
          <header className="app-header">
            <div className="header-content">
              <h2>Socio</h2>
              <div className="user-info">
                <span>Пользователь: {username}</span>
                <button onClick={logout} className="logout-btn">
                  Выход
                </button>
              </div>
            </div>
          </header>
          <main className="app-main">
            <ServicesTable />
          </main>
        </div>
      )}
    </div>
  );
}

export default App;


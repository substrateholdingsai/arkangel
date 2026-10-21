import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import './styles.css';

/**
 * La sesión es una cookie HttpOnly que el Worker emite al hacer login: el
 * navegador la manda sola en cada petición, así que la SPA no tiene que
 * guardar ni reenviar ningún token. `AuthProvider` sólo comprueba al arrancar
 * si esa cookie sigue viva.
 */
const root = ReactDOM.createRoot(document.getElementById('root')!);

root.render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);

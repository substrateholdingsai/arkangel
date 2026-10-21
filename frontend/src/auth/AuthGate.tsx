/**
 * Pantalla de acceso al panel.
 *
 * Formulario único con dos modos: "Iniciar sesión" y "Registrarse". La
 * contraseña viaja al Worker, que la verifica con PBKDF2 y devuelve la cookie
 * de sesión; el navegador nunca ve ni guarda el hash.
 *
 * Nota de seguridad: la sesión es una cookie HttpOnly, así que este
 * componente no puede (ni debe) leerla. Lo único que guarda el navegador es
 * qué despacho está activo, y sólo para no perderlo al recargar.
 */

import { useState, type FormEvent } from 'react';
import { Alert, Button } from '@ds';
import { ApiError } from '../api';
import { useAuth } from './AuthContext';

type Modo = 'login' | 'registro';

export function AuthGate() {
  const { login, register } = useAuth();
  const [modo, setModo] = useState<Modo>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const esRegistro = modo === 'registro';

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      if (esRegistro) {
        await register({
          email: email.trim(),
          password,
          fullName: fullName.trim(),
          tenantName: tenantName.trim() || undefined,
        });
      } else {
        await login(email.trim(), password);
      }
    } catch (excepcion) {
      if (excepcion instanceof ApiError) setError(excepcion.message);
      else setError('No se pudo completar la operación. Intenta de nuevo.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="text-xl font-semibold text-slate-100">Arkangel</h1>
          <p className="text-sm text-slate-400 mt-1">
            {esRegistro ? 'Crea tu cuenta y tu despacho' : 'Cobranza que respeta la ley'}
          </p>
        </div>

        <form
          onSubmit={enviar}
          className="bg-slate-900 border border-slate-800 rounded-lg p-6 space-y-4"
        >
          {esRegistro ? (
            <>
              <Campo
                etiqueta="Nombre completo"
                value={fullName}
                onChange={setFullName}
                autoComplete="name"
                required
              />
              <Campo
                etiqueta="Nombre del despacho"
                value={tenantName}
                onChange={setTenantName}
                placeholder="Opcional. Por defecto: Despacho {tu nombre}"
                autoComplete="organization"
              />
            </>
          ) : null}

          <Campo
            etiqueta="Correo electrónico"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            required
          />

          <div>
            <label
              htmlFor="ark-password"
              className="block text-xs font-medium text-slate-400 mb-1.5"
            >
              Contraseña
            </label>
            <input
              id="ark-password"
              type="password"
              value={password}
              onChange={(evento) => setPassword(evento.target.value)}
              autoComplete={esRegistro ? 'new-password' : 'current-password'}
              required
              minLength={esRegistro ? 12 : undefined}
              className="w-full rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
            />
            {esRegistro ? (
              <p className="text-xs text-slate-500 mt-1.5">Mínimo 12 caracteres.</p>
            ) : null}
          </div>

          {error ? (
            <Alert tone="err" title="No se pudo entrar">
              {error}
            </Alert>
          ) : null}

          <Button type="submit" variant="accent" size="md" disabled={enviando} className="w-full">
            {enviando ? 'Un momento…' : esRegistro ? 'Crear cuenta' : 'Entrar'}
          </Button>

          <button
            type="button"
            onClick={() => {
              setModo(esRegistro ? 'login' : 'registro');
              setError(null);
            }}
            className="w-full text-center text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            {esRegistro ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Regístrate'}
          </button>
        </form>

        <p className="text-center text-xs text-slate-600 mt-4">
          La sesión viaja en una cookie HttpOnly: tu contraseña nunca sale del navegador hacia otro
          sitio.
        </p>
      </div>
    </div>
  );
}

function Campo({
  etiqueta,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoComplete,
  required,
}: {
  etiqueta: string;
  value: string;
  onChange: (valor: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
}) {
  const id = `ark-${etiqueta.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-400 mb-1.5">
        {etiqueta}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(evento) => onChange(evento.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        className="w-full rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
      />
    </div>
  );
}

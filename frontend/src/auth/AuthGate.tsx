/**
 * Pantalla de acceso al panel.
 *
 * Formulario con tres modos: iniciar sesión, pedir el enlace de restablecimiento
 * y fijar la nueva contraseña (enlace del correo). La
 * contraseña viaja al Worker, que la verifica con PBKDF2 y devuelve la cookie
 * de sesión; el navegador nunca ve ni guarda el hash.
 *
 * Nota de seguridad: la sesión es una cookie HttpOnly, así que este
 * componente no puede (ni debe) leerla. Lo único que guarda el navegador es
 * qué despacho está activo, y sólo para no perderlo al recargar.
 */

import { useState, type FormEvent } from 'react';
import { Alert, Button } from '@ds';
import { ApiError, auth as authApi } from '../api';
import { useAuth } from './AuthContext';

/**
 * El registro publico esta cerrado (el panel es por invitacion), asi que no hay
 * modo "registro". `olvide` pide el enlace; `nueva` lo consume (llega desde el
 * correo como `/?auth=restablecer&token=...`).
 */
type Modo = 'login' | 'olvide' | 'nueva';

/** Lee el enlace del correo, si lo hay. */
function leerEnlace(): { modo: Modo; token: string } {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') ?? '';
  if (params.get('auth') === 'restablecer' && /^[0-9a-f]{64}$/.test(token)) {
    return { modo: 'nueva', token };
  }
  return { modo: 'login', token: '' };
}

/** Quita el token de la URL para que no quede en el historial. */
function limpiarUrl() {
  window.history.replaceState(null, '', window.location.pathname);
}

export function AuthGate() {
  const { login } = useAuth();
  const [enlace] = useState(leerEnlace);
  const [modo, setModo] = useState<Modo>(enlace.modo);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  function cambiarModo(siguiente: Modo) {
    setModo(siguiente);
    setError(null);
    setAviso(null);
    setPassword('');
  }

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    setAviso(null);
    setEnviando(true);
    try {
      if (modo === 'login') {
        await login(email.trim(), password);
      } else if (modo === 'olvide') {
        const respuesta = await authApi.requestPasswordReset(email.trim());
        setAviso(respuesta.message);
      } else {
        await authApi.resetPassword(enlace.token, password);
        limpiarUrl();
        setModo('login');
        setPassword('');
        setAviso('Contraseña actualizada. Ya puedes iniciar sesión.');
      }
    } catch (excepcion) {
      if (excepcion instanceof ApiError) setError(excepcion.message);
      else setError('No se pudo completar la operación. Intenta de nuevo.');
    } finally {
      setEnviando(false);
    }
  }

  const subtitulo =
    modo === 'olvide'
      ? 'Te enviaremos un enlace para restablecer tu contraseña'
      : modo === 'nueva'
        ? 'Elige tu nueva contraseña'
        : 'Cobranza que respeta la ley';

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="text-xl font-semibold text-slate-100">Arkangel</h1>
          <p className="text-sm text-slate-400 mt-1">{subtitulo}</p>
        </div>

        <form
          onSubmit={enviar}
          className="bg-slate-900 border border-slate-800 rounded-lg p-6 space-y-4"
        >
          {modo !== 'nueva' ? (
            <Campo
              etiqueta="Correo electrónico"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
              required
            />
          ) : null}

          {modo !== 'olvide' ? (
            <div>
              <label
                htmlFor="ark-password"
                className="block text-xs font-medium text-slate-400 mb-1.5"
              >
                {modo === 'nueva' ? 'Nueva contraseña' : 'Contraseña'}
              </label>
              <input
                id="ark-password"
                type="password"
                value={password}
                onChange={(evento) => setPassword(evento.target.value)}
                autoComplete={modo === 'nueva' ? 'new-password' : 'current-password'}
                required
                minLength={modo === 'nueva' ? 12 : undefined}
                maxLength={128}
                className="w-full rounded-md bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
              />
              {modo === 'nueva' ? (
                <p className="text-xs text-slate-500 mt-1.5">Entre 12 y 128 caracteres.</p>
              ) : null}
            </div>
          ) : null}

          {aviso ? (
            <Alert tone="ok" title="Listo">
              {aviso}
            </Alert>
          ) : null}
          {error ? (
            <Alert tone="err" title="No se pudo completar">
              {error}
            </Alert>
          ) : null}

          <Button type="submit" variant="accent" size="md" disabled={enviando} className="w-full">
            {enviando
              ? 'Un momento…'
              : modo === 'olvide'
                ? 'Enviar enlace'
                : modo === 'nueva'
                  ? 'Guardar contraseña'
                  : 'Entrar'}
          </Button>

          {modo === 'login' ? (
            <button
              type="button"
              onClick={() => cambiarModo('olvide')}
              className="w-full text-center text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              ¿Olvidaste tu contraseña?
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                limpiarUrl();
                cambiarModo('login');
              }}
              className="w-full text-center text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              Volver a iniciar sesión
            </button>
          )}
        </form>

        <p className="text-center text-xs text-slate-600 mt-4">
          El acceso es por invitación. Si necesitas una cuenta, solicítala a tu administrador.
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

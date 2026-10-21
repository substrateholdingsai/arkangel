/**
 * Contexto de autenticación del panel.
 *
 * Hace un **bootstrap silencioso**: al montar llama a `GET /api/auth/session`
 * y, si la cookie `ark_session` sigue viva, entra al panel sin pedir nada.
 * Si no, la pantalla de acceso (`AuthGate`) aparece.
 *
 * El despacho activo se guarda en `localStorage`: recargar la página no cierra
 * la sesión ni pierde el despacho en el que estabas. Cambiar de despacho es
 * sólo mover el selector: la cookie no se toca, así que no hay que volver a
 * iniciar sesión.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  auth as authApi,
  setActiveTenantId,
  type AuthSession,
  type AuthTenant,
} from '../api';

const CLAVE_DESPACHO = 'ark.auth.despacho.v1';

interface AuthContextValue {
  /** Sesión activa, o `null` si no hay nadie dentro. */
  session: AuthSession | null;
  /** ¿Estamos comprobando la sesión? (la pantalla de "Cargando…"). */
  loading: boolean;
  /** Despacho en el que se está operando. */
  activeTenant: AuthTenant | null;
  /** Despachos a los que el usuario tiene acceso. */
  tenants: AuthTenant[];
  /** Cambia de despacho sin cerrar sesión. */
  switchTenant: (tenantId: string) => void;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    fullName: string;
    tenantName?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTenantId, setTenantId] = useState<string | null>(null);

  const tenants = useMemo<AuthTenant[]>(() => session?.tenants ?? [], [session]);

  /**
   * Escoge el despacho activo: el guardado, si sigue siendo válido; si no,
   * el primero al que el usuario tiene acceso.
   */
  const elegirDespacho = useCallback((disponibles: AuthTenant[]): string | null => {
    if (disponibles.length === 0) return null;
    const guardado = localStorage.getItem(CLAVE_DESPACHO);
    if (guardado && disponibles.some((t) => t.tenantId === guardado)) return guardado;
    return disponibles[0]?.tenantId ?? null;
  }, []);

  const aplicarSesion = useCallback(
    (nueva: AuthSession | null) => {
      setSession(nueva);
      const id = elegirDespacho(nueva?.tenants ?? []);
      setTenantId(id);
      setActiveTenantId(id);
      if (id) localStorage.setItem(CLAVE_DESPACHO, id);
      else localStorage.removeItem(CLAVE_DESPACHO);
    },
    [elegirDespacho]
  );

  const refresh = useCallback(async () => {
    try {
      aplicarSesion(await authApi.session());
    } catch (error) {
      // 401 es el caso normal de "no hay nadie dentro"; no es un fallo.
      if (error instanceof ApiError && error.status === 401) {
        aplicarSesion(null);
        return;
      }
      aplicarSesion(null);
    }
  }, [aplicarSesion]);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const actual = await authApi.session();
        if (vivo) aplicarSesion(actual);
      } catch {
        if (vivo) aplicarSesion(null);
      } finally {
        if (vivo) setLoading(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [aplicarSesion]);

  const switchTenant = useCallback(
    (tenantId: string) => {
      if (!tenants.some((t) => t.tenantId === tenantId)) return;
      setTenantId(tenantId);
      setActiveTenantId(tenantId);
      localStorage.setItem(CLAVE_DESPACHO, tenantId);
    },
    [tenants]
  );

  const login = useCallback(
    async (email: string, password: string) => {
      aplicarSesion(await authApi.login(email, password));
    },
    [aplicarSesion]
  );

  const register = useCallback(
    async (input: { email: string; password: string; fullName: string; tenantName?: string }) => {
      aplicarSesion(await authApi.register(input));
    },
    [aplicarSesion]
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      aplicarSesion(null);
    }
  }, [aplicarSesion]);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await authApi.changePassword(currentPassword, newPassword);
      // El cambio de contraseña revoca la sesión en el servidor y limpia la cookie.
      // Forzamos un refresh para que el contexto se entere de que ya no hay sesión.
      await refresh();
    },
    [refresh]
  );

  const valor = useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      activeTenant: tenants.find((t) => t.tenantId === activeTenantId) ?? null,
      tenants,
      switchTenant,
      login,
      register,
      logout,
      refresh,
      changePassword,
    }),
    [
      session,
      loading,
      tenants,
      activeTenantId,
      switchTenant,
      login,
      register,
      logout,
      refresh,
      changePassword,
    ]
  );

  return <AuthContext.Provider value={valor}>{children}</AuthContext.Provider>;
}

/** Acceso al contexto de autenticación. */
export function useAuth(): AuthContextValue {
  const contexto = useContext(AuthContext);
  if (!contexto) {
    throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  }
  return contexto;
}

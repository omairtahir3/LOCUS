import { createContext, useContext } from 'react';

/**
 * Split out of Toast.jsx so that file exports components only -- react-refresh
 * cannot hot-reload a module that mixes components with other exports, and a
 * provider that drops its state on every save is worse than no fast refresh.
 */
export const ToastContext = createContext(null);

/**
 * Returns a function, and a no-op if the provider is absent rather than
 * throwing: a missing toast must never be the reason a page fails to render.
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  return ctx ? ctx.toast : () => {};
}

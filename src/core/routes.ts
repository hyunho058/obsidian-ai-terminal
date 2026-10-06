import type { IncomingMessage, ServerResponse } from 'http';
import type { Disposer } from './types';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Handles one authenticated request. The bridge HTTP server (T6) checks the bearer token before any route
 * runs, so handlers never see unauthenticated requests. The handler must end the response.
 */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/**
 * Extra HTTP routes served by the bridge server next to `/mcp` (e.g. T9's `POST /snapshot`).
 * Routes may be added before or after the server starts — the server looks them up per request.
 */
export class BridgeRouteRegistry {
  private readonly routes = new Map<string, RouteHandler>();

  /** `path` is matched exactly (query string ignored), e.g. `/snapshot`. Throws on a duplicate route. */
  addRoute(method: HttpMethod, path: string, handler: RouteHandler): Disposer {
    if (!path.startsWith('/')) throw new Error(`Route path must start with "/": ${path}`);
    const key = routeKey(method, path);
    if (this.routes.has(key)) throw new Error(`Route already registered: ${method} ${path}`);
    this.routes.set(key, handler);
    return () => {
      if (this.routes.get(key) === handler) this.routes.delete(key);
    };
  }

  /** Finds the handler for a request. `url` may contain a query string. */
  match(method: string | undefined, url: string | undefined): RouteHandler | undefined {
    if (!method || !url) return undefined;
    const path = url.split('?', 1)[0] ?? url;
    return this.routes.get(routeKey(method.toUpperCase(), path));
  }

  list(): Array<{ method: HttpMethod; path: string }> {
    return [...this.routes.keys()].map((k) => {
      const [method, path] = k.split(' ', 2) as [HttpMethod, string];
      return { method, path };
    });
  }

  clear(): void {
    this.routes.clear();
  }
}

function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

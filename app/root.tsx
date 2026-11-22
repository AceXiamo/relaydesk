import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from "react-router";
import type { LinksFunction } from "react-router";
import "./app.css";

export const links: LinksFunction = () => [
  {
    rel: "icon",
    type: "image/png",
    href: "/favicon.png",
  },
  {
    rel: "apple-touch-icon",
    href: "/apple-touch-icon.png",
  },
  {
    rel: "preload",
    href: "/fonts/geist.woff2",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
  {
    rel: "preload",
    href: "/fonts/geist-mono.woff2",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
];

const THEME_INIT_SCRIPT = `(() => {
  try {
    const saved = localStorage.getItem("relaydesk.theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = saved === "dark" || (saved !== "light" && prefersDark);
    document.documentElement.classList.toggle("dark", isDark);
  } catch {}
})();`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta name="theme-color" content="#0b0c0e" />
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="antialiased selection:bg-indigo-500/20 selection:text-indigo-600 dark:selection:text-indigo-300">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: { error: unknown }) {
  let title = "页面加载出错";
  let detail = "发生了未预期的错误，请刷新页面重试。";

  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    detail = typeof error.data === "string" ? error.data : detail;
  } else if (error instanceof Error) {
    detail = error.message;
  }

  return (
    <main className="min-h-dvh flex items-center justify-center p-6 bg-zinc-50 dark:bg-[#0b0c0e] text-zinc-900 dark:text-zinc-100">
      <div className="max-w-md w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#111215] p-6 shadow-sm">
        <p className="text-xs font-mono uppercase tracking-wider text-zinc-500 mb-2">
          Relaydesk
        </p>
        <h1 className="text-lg font-semibold mb-2">{title}</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-5 break-words">
          {detail}
        </p>
        <a
          href="/"
          className="inline-flex items-center justify-center rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-950 px-3.5 py-2 text-sm font-medium hover:opacity-90 transition"
        >
          返回工作台
        </a>
      </div>
    </main>
  );
}

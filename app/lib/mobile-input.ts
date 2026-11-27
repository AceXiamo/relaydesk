import { useEffect, useState } from "react";

export const MOBILE_COMPOSER_MEDIA_QUERY =
  "(max-width: 639.98px), (hover: none) and (pointer: coarse)";

export function isMobileComposerDevice(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") {
    try {
      return window.matchMedia(MOBILE_COMPOSER_MEDIA_QUERY).matches;
    } catch {
      // Fall through to viewport width fallback.
    }
  }
  return window.innerWidth > 0 && window.innerWidth < 640;
}

export function useIsMobileComposer(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof window.matchMedia !== "function") {
      const update = () => setIsMobile(window.innerWidth > 0 && window.innerWidth < 640);
      update();
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const mql = window.matchMedia(MOBILE_COMPOSER_MEDIA_QUERY);
    setIsMobile(mql.matches);
    const onChange = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches);
    };

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }

    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  return isMobile;
}

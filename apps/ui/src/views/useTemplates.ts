import { useEffect, useState } from 'react';
import { bridge } from '../chat/useChimera.ts';

// The shipped automations, read once.
//
// Read-only and read from main: a template is data this build ships, and the
// renderer's job is to show it and hand it to the canvas.

export interface ShippedTemplate {
  id: string;
  name: string;
  audience: string;
  summary: string;
  needs: string[];
  steps: {
    id?: string;
    kind?: string;
    roleId: string;
    instruction: string;
    settings?: Record<string, unknown>;
  }[];
  edges?: [string, string][];
  egressAllowlist?: string[];
  egressMode?: 'allowlist' | 'browse' | 'open';
}

export function useTemplates(): ShippedTemplate[] {
  const [templates, setTemplates] = useState<ShippedTemplate[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const result = await bridge().invoke<{ templates: ShippedTemplate[] }>('template:list', {});
        setTemplates(result.templates);
      } catch {
        // A gallery that will not load leaves the composer, which is the way in
        // that has always existed. Nothing here is worth an error on the home
        // screen.
      }
    })();
  }, []);

  return templates;
}

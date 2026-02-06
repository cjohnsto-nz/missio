// Shared webview state and helpers — imported by all webview modules.

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

export interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export const vscode: VsCodeApi = acquireVsCodeApi();

export let currentRequest: any = null;
export let resolvedVariables: Record<string, string> = {};
export let variableSources: Record<string, string> = {};
export let showResolvedVars = false;
export let updateDocumentTimer: ReturnType<typeof setTimeout> | null = null;
export let ignoreNextLoad = false;
export let currentBodyType = 'none';
export let currentLang = 'json';

export function setCurrentRequest(req: any): void { currentRequest = req; }
export function setResolvedVariables(vars: Record<string, string>): void { resolvedVariables = vars; }
export function setVariableSources(sources: Record<string, string>): void { variableSources = sources; }
export function setShowResolvedVars(val: boolean): void { showResolvedVars = val; }
export function getResolvedVariables(): Record<string, string> { return resolvedVariables; }
export function getVariableSources(): Record<string, string> { return variableSources; }
export function getShowResolvedVars(): boolean { return showResolvedVars; }
export function setUpdateDocumentTimer(timer: ReturnType<typeof setTimeout> | null): void { updateDocumentTimer = timer; }
export function setIgnoreNextLoad(val: boolean): void { ignoreNextLoad = val; }
export function setCurrentBodyType(type: string): void { currentBodyType = type; }
export function setCurrentLang(lang: string): void { currentLang = lang; }

export function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export function $input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

export function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

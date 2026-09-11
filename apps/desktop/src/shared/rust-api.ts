import type { ContentPage, EventPage, EventQuery, Health, RenameSession, SessionHead, SessionLookupResult, SessionPage, SessionQuery, SessionSummary, WorkspacePage, WorkspaceQuery } from "@prospero/protocol/rust-daemon";

export type RustContent = { bytes: Uint8Array; nextOffset: number };
export type RustDesktopApi = {
  platform: string;
  health(): Promise<Health>;
  sessions(query: SessionQuery): Promise<SessionPage>;
  summary(workspace?: string): Promise<SessionSummary>;
  workspaces(query: WorkspaceQuery): Promise<WorkspacePage>;
  lookup(ids: string[]): Promise<SessionLookupResult>;
  session(id: string): Promise<SessionHead>;
  rename(id: string, input: RenameSession): Promise<SessionHead>;
  events(query: EventQuery): Promise<EventPage>;
  contents(id: string, cursor?: string): Promise<ContentPage>;
  content(id: string, content: string, offset: number): Promise<RustContent>;
};

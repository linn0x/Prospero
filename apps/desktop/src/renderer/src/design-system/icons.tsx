import { Archive, ArrowRight, Check, ChevronDown, ChevronUp, CircleAlert, Columns2, Copy, File, FileDiff, Folder, FolderOpen, Info, ListTodo, Maximize2, Minimize2, MoreHorizontal, Paperclip, Play, Plus, RefreshCw, Search, Server, Settings2, Square, Terminal, Trash2, UserRound, Wifi, X, Palette, Cpu, Eye, type LucideProps } from "lucide-react";

const icons = {
  settings: Settings2,
  search: Search,
  refresh: RefreshCw,
  terminal: Terminal,
  archive: Archive,
  delete: Trash2,
  folder: Folder,
  folderOpen: FolderOpen,
  copy: Copy,
  attachment: Paperclip,
  model: Cpu,
  expand: Maximize2,
  collapse: Minimize2,
  close: X,
  add: Plus,
  arrowRight: ArrowRight,
  check: Check,
  alert: CircleAlert,
  appearance: Palette,
  server: Server,
  accounts: UserRound,
  relay: Wifi,
  tasks: ListTodo,
  diff: FileDiff,
  execution: Play,
  sidebar: Columns2,
  stop: Square,
  more: MoreHorizontal,
  info: Info,
  file: File,
  preview: Eye,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
} as const;

export type DesktopIconName = keyof typeof icons;

export function DesktopIcon({ name, navigation = false, size, ...props }: Omit<LucideProps, "size" | "strokeWidth"> & { name: DesktopIconName; navigation?: boolean; size?: number }) {
  const Icon = icons[name];
  const labelled = Boolean(props["aria-label"] || props["aria-labelledby"]);
  return <Icon size={size ?? (navigation ? 18 : 16)} strokeWidth={2} aria-hidden={labelled ? undefined : true} role={labelled ? "img" : undefined} {...props} />;
}

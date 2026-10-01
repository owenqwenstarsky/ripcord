export type Person = {
  id: string;
  username: string;
  displayName: string;
  avatarId: string | null;
  isAdmin?: boolean;
  friendsOnly?: boolean;
  email?: string | null;
  emailVerified?: boolean;
  notifyMentions?: boolean;
  notifyDms?: boolean;
};
export type ChatRoom = {
  id: string;
  kind: 'TEXT' | 'DIRECT' | 'GROUP';
  name: string;
  topic: string;
  serverId: string | null;
  categoryId: string | null;
  ownerId: string | null;
  permissions: string;
  position: number;
  slowMode: number;
  synchronized: boolean;
  unread: number;
  mentions: number;
  readSeq?: string;
  firstUnreadId?: string | null;
  latestSeq?: string | null;
  latestEvent?: string;
  lastActivityAt?: string;
  muted?: boolean;
  members?: { user: Person }[];
};
export type Community = {
  id: string;
  name: string;
  description: string;
  icon: string;
  ownerId: string;
  permissions: string;
  muted?: boolean;
  categories: { id: string; name: string; position: number }[];
  rooms: ChatRoom[];
};
export type ChatMessage = {
  id: string;
  seq: string;
  roomId: string;
  authorId: string;
  author: Person;
  content: string | null;
  nonce: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  reply: { id: string; content: string | null; deletedAt: string | null; author: Person } | null;
  attachments: { id: string; name: string; size: number; mime: string }[];
  mentions?: { userId: string }[];
  reactions: { userId: string; emoji: string }[];
};
export type Workspace = {
  user: Person;
  instance: {
    name: string;
    maxMessageLength: number;
    maxFileBytes: number;
    maxAttachments: number;
  };
  servers: Community[];
  dms: ChatRoom[];
  relationships: { id: string; fromId: string; toId: string; kind: string; user: Person }[];
};

export type ServerInfo = Omit<Community, 'rooms' | 'categories'> & {
  position: number;
  roles: {
    id: string;
    name: string;
    color: string;
    position: number;
    permissions: string;
    everyone: boolean;
  }[];
  members: {
    id: string;
    user: Person;
    nickname: string | null;
    timeoutUntil: string | null;
    roles: { role: { id: string; name: string; color: string; position: number } }[];
  }[];
  rooms: (ChatRoom & { overrides: OverrideData[] })[];
  categories: { id: string; name: string; position: number; overrides: OverrideData[] }[];
};
export type OverrideData = { targetType: string; targetId: string; allow: string; deny: string };

export type HistoryPage = {
  messages: ChatMessage[];
  hasMore: boolean;
  hasNewer?: boolean;
  olderCursor?: string;
  newerCursor?: string;
};
export type SendStatus = {
  status: 'sent' | 'not-found' | 'cancelled';
  message: ChatMessage | null;
};
export type Invitation = {
  kind: 'community' | 'instance';
  serverId: string | null;
  server: Community | null;
  serverName?: string;
};

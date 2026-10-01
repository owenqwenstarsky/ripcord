export type Person = {
  id: string;
  username: string;
  displayName: string;
  avatarId: string | null;
  isAdmin?: boolean;
  friendsOnly?: boolean;
  email?: string | null;
  emailVerified?: boolean;
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
  members?: { user: Person }[];
};
export type Community = {
  id: string;
  name: string;
  description: string;
  icon: string;
  ownerId: string;
  permissions: string;
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

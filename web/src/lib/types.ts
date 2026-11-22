export type UserRole = 'merchant' | 'owner' | 'moderator';

export interface UserProfile {
  id: number;
  role: UserRole;
  fullName: string;
  storeName: string;
  phone: string;
  email: string;
  taxId?: string;
  instapay?: string;
  status: string;
  plan: string;
  planName?: string;
  planCycle?: string;
  planExpiresAt?: string | null;
  totpEnabled?: boolean;
  isDemo?: boolean;
  permissions?: Record<string, boolean>;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  cat: string;
  price: number;
  cost: number;
  stock: number;
  markets: string;
  image?: string;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  rejectReason?: string;
}

export interface Order {
  id: number;
  no: number;
  market: string;
  customer: string;
  phone?: string;
  gov: string;
  pay: string;
  courier: string;
  items?: string;
  total: number;
  status: number;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  rejectReason?: string;
  awbNumber?: string;
  courierStatus?: string;
  createdAt: string;
}

export interface SupportTicket {
  id: number;
  userId?: number;
  storeName?: string;
  email?: string;
  phone?: string;
  subject: string;
  message: string;
  reply?: string;
  status: 'open' | 'answered' | 'closed';
  createdAt: string;
  updatedAt?: string;
}

export interface ServiceRequest {
  id: number;
  userId?: number;
  storeName?: string;
  phone?: string;
  contactPhone?: string;
  serviceId: string;
  serviceTitle: string;
  price: number;
  notes?: string;
  adminNotes?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  createdAt: string;
}

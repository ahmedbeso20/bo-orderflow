export type UserRole = 'client' | 'owner' | 'moderator';

export interface UserProfile {
  id: number;
  role: UserRole;
  fullName: string;
  storeName: string;
  phone: string;
  email: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  taxId?: string;
  instaPayHandle?: string;
  status: string;
  plan: string;
  planName?: string;
  planCycle?: string;
  planExpiresAt?: string | null;
  totpEnabled?: boolean;
  setup2faRequired?: boolean;
  deletionRequestedAt?: string | null;
  isDemo?: boolean;
  readOnly?: boolean;
  impersonatedBy?: number | null;
  permissions?: Record<string, boolean>;
}

export interface SettingsData {
  storeName: string;
  phone?: string;
  email?: string;
  storePhone?: string;
  storeEmail?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  taxId: string;
  instaPayHandle: string;
  autoSync?: boolean;
  lowStockAlert?: number;
  totpEnabled?: boolean;
  deletionRequestedAt?: string | null;
  integrations?: Record<string, boolean>;
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
  source?: string;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  rejectReason?: string;
}

export interface Order {
  id: number;
  no: number;
  market: string;
  customer: string;
  phone?: string;
  address?: string;
  gov: string;
  pay: string;
  courier: string;
  items?: string;
  total: number;
  cost?: number;
  costEstimated?: boolean;
  fulfillmentChannel?: string;
  status: number;
  source?: string;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  rejectReason?: string;
  awb?: string;
  awbNumber?: string;
  courierStatus?: string;
  trackingUrl?: string;
  courierTrackingUrl?: string;
  returnReason?: string;
  cancelReason?: string;
  createdAt: string;
}

export interface CustomerItem {
  id: number;
  name: string;
  phone: string;
  email?: string;
  gov: string;
  address?: string;
  notes?: string;
  tags?: string;
  ordersCount: number;
  deliveredCount?: number;
  returnedCount?: number;
  cancelledCount?: number;
  rtoCount?: number;
  totalSpent: number;
  lastOrderAt?: string | null;
  segment?: string;
}

export interface NotificationItem {
  id: number;
  title: string;
  body: string;
  type: string;
  link?: string;
  readAt?: string | null;
  createdAt: string;
}

export interface SupportTicket {
  id: number;
  userId?: number | null;
  storeName?: string;
  name?: string;
  contact?: string;
  subject: string;
  message: string;
  reply?: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  createdAt: string;
  updatedAt?: string | null;
}

export interface ServiceRequest {
  id: number;
  userId?: number | null;
  refCode?: string;
  ref_code?: string;
  serviceKey?: string;
  service_key?: string;
  serviceTitle?: string;
  service_title?: string;
  storeName?: string;
  phone?: string;
  platforms?: string;
  monthlyOrders?: string;
  notes?: string;
  adminNotes?: string;
  admin_notes?: string;
  status: 'pending' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  createdAt?: string;
  created_at?: string;
}

export interface PlanItem {
  id: string;
  name: string;
  price?: number;
  yearly?: number;
  priceMonthly?: number;
  priceYearly?: number;
  products: number | null;
  markets: number;
  ai: number;
}

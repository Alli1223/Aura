import { EmptyState, Page, PageHeader } from '../components/Page';

export function AdminPage() {
  return (
    <Page>
      <PageHeader
        title="Admin"
        subtitle="Manage users, libraries, access grants and server settings."
      />
      <EmptyState
        title="Admin tools coming soon"
        message="User management, the library access matrix, scan controls and server settings arrive with the admin-dashboard feature."
      />
    </Page>
  );
}

import { EmptyState, Page, PageHeader } from '../components/Page';
import { useAuth } from '../auth/context';

export function HomePage() {
  const { user } = useAuth();

  return (
    <Page>
      <PageHeader
        title={`Welcome back, ${user?.username ?? ''}`}
        subtitle="Your libraries and recently added media will appear here."
      />
      <EmptyState
        title="Nothing to show yet"
        message="Continue Watching, Recently Added and On Deck rows land with the home-screen feature. Pick a library from the sidebar to start browsing."
      />
    </Page>
  );
}

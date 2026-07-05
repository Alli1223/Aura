import { useParams } from 'react-router';

import { useLibraries } from '../api/queries';
import { EmptyState, Page, PageHeader } from '../components/Page';

export function LibraryPage() {
  const { id } = useParams();
  const libraries = useLibraries();
  const library = libraries.data?.find((entry) => entry.id === id);

  return (
    <Page>
      <PageHeader title={library?.name ?? 'Library'} subtitle="Browse this library's media." />
      <EmptyState
        title="Browsing coming soon"
        message="The poster-grid browse view with sorting and filtering arrives with the library-browse feature."
      />
    </Page>
  );
}

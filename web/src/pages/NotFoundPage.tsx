import { Link } from 'react-router';

import { Page, PageHeader } from '../components/Page';

export function NotFoundPage() {
  return (
    <Page>
      <PageHeader title="Page not found" subtitle="That page doesn't exist." />
      <Link to="/" className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>
        Back to home
      </Link>
    </Page>
  );
}

import { useEffect } from 'react';
import { useLocation, type Location } from 'react-router';

/** Reports the current router location so tests can assert URL query state. */
export function LocationProbe({ onLocation }: { onLocation: (location: Location) => void }) {
  const location = useLocation();
  useEffect(() => {
    onLocation(location);
  }, [location, onLocation]);
  return null;
}

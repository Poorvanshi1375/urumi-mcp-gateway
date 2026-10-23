import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import { RequireAdmin, Shell } from './Shell';
import { AcceptInvite, Login } from './pages/Auth';
import { Consent } from './pages/Consent';
import { Servers } from './pages/Servers';
import { Keys } from './pages/Keys';
import { Audit } from './pages/Audit';
import { Users } from './pages/Users';
import { Connect } from './pages/Connect';
import { Chat } from './pages/Chat';
import { HostedServers } from './pages/Hosted';
import { Stores } from './pages/Stores';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true } } });

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/invite/:token', element: <AcceptInvite /> },
  { path: '/oauth/consent', element: <Consent /> },
  {
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },
      { path: '/chat', element: <Chat /> },
      { path: '/servers', element: <Servers /> },
      { path: '/audit', element: <Audit /> },
      { path: '/keys', element: <Keys /> },
      { path: '/connect', element: <Connect /> },
      { path: '/users', element: <RequireAdmin><Users /></RequireAdmin> },
      { path: '/hosted', element: <RequireAdmin><HostedServers /></RequireAdmin> },
      { path: '/stores', element: <Stores /> },
      { path: '*', element: <Navigate to="/chat" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>
  </StrictMode>,
);

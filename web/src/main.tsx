import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AuthProvider } from './lib/auth'
import { DialogsProvider } from './components/dialogs'
import { App } from './App'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true },
  },
})

/**
 * The theme choice is a per-viewer convenience kept in localStorage by next-themes; light
 * until a viewer picks another. Sign-in and invite pages are always light; the saved choice
 * applies again after sign-in.
 */
function Themed({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const light = pathname === '/login' || pathname.startsWith('/setup/')
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange forcedTheme={light ? 'light' : undefined}>
      {children}
    </ThemeProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Themed>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={200}>
            <AuthProvider>
              <DialogsProvider>
                <App />
              </DialogsProvider>
            </AuthProvider>
            <Toaster richColors closeButton position="top-right" />
          </TooltipProvider>
        </QueryClientProvider>
      </Themed>
    </BrowserRouter>
  </StrictMode>
)

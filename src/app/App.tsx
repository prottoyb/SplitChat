import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { LoadingState } from '../shared/ui'
import { AuthProvider, ProtectedRoute } from '../features/auth'
import AppLayout from './AppLayout'
import './App.css'

// Route pages load on demand, so the first paint only ships the shell.
const AuthPage = lazy(() => import('../features/auth/AuthPage'))
const ResetPasswordPage = lazy(() => import('../features/auth/pages/ResetPasswordPage'))
const ProfilePage = lazy(() => import('../features/auth/pages/ProfilePage'))
const DashboardPage = lazy(() => import('../features/dashboard/DashboardPage'))
const GroupsRoute = lazy(() => import('./GroupsRoute'))
const GroupWorkspace = lazy(() => import('./workspace/GroupWorkspace'))
const NewExpensePage = lazy(() => import('../features/expenses/pages/NewExpensePage'))
const EditExpensePage = lazy(() => import('../features/expenses/pages/EditExpensePage'))
const ExpensesPage = lazy(() => import('../features/expenses/pages/ExpensesPage'))
const ExpenseDetailsPage = lazy(() => import('../features/expenses/pages/ExpenseDetailsPage'))
const ActivityPage = lazy(() => import('../features/activity/ActivityPage'))
const EditProposalPage = lazy(() => import('../features/smart-expense/pages/EditProposalPage'))

const pageFallback = <LoadingState title="Loading..." />

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={pageFallback}>
          <Routes>
            <Route path="/login" element={<AuthPage />} />
            {/* Public: the recovery session comes from the emailed link. */}
            <Route path="/reset-password" element={<ResetPasswordPage />} />

            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="groups" element={<GroupsRoute />} />
              {/* The workspace owns its sections (overview, expenses, balances, activity, members). */}
              <Route path="groups/:groupId/*" element={<GroupWorkspace />} />
              <Route path="groups/:groupId/expenses/new" element={<NewExpensePage />} />
              <Route path="groups/:groupId/proposals/:candidateId/edit" element={<EditProposalPage />} />
              <Route path="expenses" element={<ExpensesPage />} />
              <Route path="expenses/:expenseId" element={<ExpenseDetailsPage />} />
              <Route path="expenses/:expenseId/edit" element={<EditExpensePage />} />
              <Route path="activity" element={<ActivityPage />} />
              <Route path="profile" element={<ProfilePage />} />
            </Route>
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App

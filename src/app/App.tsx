import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './App.css'
import { AuthProvider } from '../features/auth/AuthContext'
import ProtectedRoute from '../features/auth/ProtectedRoute'
import AppLayout from './AppLayout'
import ActivityPage from '../features/activity/ActivityPage'
import AddExpensePage from '../features/expenses/pages/AddExpensePage'
import AuthPage from '../features/auth/AuthPage'
import DashboardPage from '../features/dashboard/DashboardPage'
import ExpensesPage from '../features/expenses/pages/ExpensesPage'
import GroupDetailsPage from '../features/groups/pages/GroupDetailsPage'
import GroupsPage from '../features/groups/pages/GroupsPage'
import ExpenseDetailsPage from '../features/expenses/pages/ExpenseDetailsPage'

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<AuthPage />} />

          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<DashboardPage />} />

            <Route
              path="groups"
              element={<GroupsPage />}
            />

            <Route
              path="groups/:groupId"
              element={<GroupDetailsPage />}
            />

            <Route
              path="groups/:groupId/expenses/new"
              element={<AddExpensePage />}
            />

            <Route
              path="expenses"
              element={<ExpensesPage />}
            />

            <Route
              path="expenses/:expenseId"
              element={<ExpenseDetailsPage />}
            />

            <Route
              path="activity"
              element={<ActivityPage />}
            />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
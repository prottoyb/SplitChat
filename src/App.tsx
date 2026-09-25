import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './App.css'
import { AuthProvider } from './auth/AuthContext'
import ProtectedRoute from './auth/ProtectedRoute'
import AppLayout from './layouts/AppLayout'
import ActivityPage from './pages/ActivityPage'
import AddExpensePage from './pages/AddExpensePage'
import AuthPage from './pages/AuthPage'
import DashboardPage from './pages/DashboardPage'
import ExpensesPage from './pages/ExpensesPage'
import GroupDetailsPage from './pages/GroupDetailsPage'
import GroupsPage from './pages/GroupsPage'
import ExpenseDetailsPage from './pages/ExpenseDetailsPage'

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
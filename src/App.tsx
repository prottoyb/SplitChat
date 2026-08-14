import { Navigate, Route, Routes } from 'react-router'
import './App.css'
import AppLayout from './layouts/AppLayout'
import ActivityPage from './pages/ActivityPage'
import DashboardPage from './pages/DashboardPage'
import ExpensesPage from './pages/ExpensesPage'
import GroupsPage from './pages/GroupsPage'

function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/groups" element={<GroupsPage />} />
        <Route path="/expenses" element={<ExpensesPage />} />
        <Route path="/activity" element={<ActivityPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
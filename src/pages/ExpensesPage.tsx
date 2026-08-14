function ExpensesPage() {
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">EXPENSES</p>
          <h2>Expenses</h2>

          <p className="subtitle">
            Review shared expenses and transactions across your groups.
          </p>
        </div>

        <button className="primary-button">+ Add expense</button>
      </header>

      <section className="panel">
        <div className="empty-state">
          <div className="empty-icon">↔</div>

          <h4>No expenses yet</h4>

          <p>
            Expenses you create or receive through your groups will appear
            here.
          </p>
        </div>
      </section>
    </>
  )
}

export default ExpensesPage
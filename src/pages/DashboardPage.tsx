function DashboardPage() {
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">OVERVIEW</p>

          <h2>Welcome to SplitChat</h2>

          <p className="subtitle">
            Manage shared expenses, balances and conversations in one place.
          </p>
        </div>

        <button className="primary-button">+ Create group</button>
      </header>

      <section className="summary-grid">
        <article className="summary-card">
          <div className="summary-icon">↓</div>

          <div>
            <p>You are owed</p>
            <h3>$0.00</h3>
            <span>No outstanding balances</span>
          </div>
        </article>

        <article className="summary-card">
          <div className="summary-icon">↑</div>

          <div>
            <p>You owe</p>
            <h3>$0.00</h3>
            <span>You're all settled up</span>
          </div>
        </article>

        <article className="summary-card">
          <div className="summary-icon">◎</div>

          <div>
            <p>Active groups</p>
            <h3>0</h3>
            <span>Create your first group</span>
          </div>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">GROUPS</p>
              <h3>Your groups</h3>
            </div>

            <button className="text-button">View all</button>
          </div>

          <div className="empty-state">
            <div className="empty-icon">◎</div>

            <h4>No groups yet</h4>

            <p>
              Create a group for a trip, household or anything else you share
              expenses for.
            </p>

            <button className="secondary-button">
              Create your first group
            </button>
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">ACTIVITY</p>
              <h3>Recent activity</h3>
            </div>
          </div>

          <div className="empty-state compact">
            <div className="empty-icon">↔</div>

            <h4>Nothing here yet</h4>

            <p>
              Expenses, settlements and group activity will appear here.
            </p>
          </div>
        </article>
      </section>

      <section className="ai-banner">
        <div className="ai-badge">AI</div>

        <div className="ai-content">
          <p className="eyebrow">COMING LATER</p>

          <h3>Turn conversations into expenses</h3>

          <p>
            SplitChat will be able to analyse group conversations, identify
            spending and prepare transactions for your approval.
          </p>
        </div>

        <div className="ai-status">Planned</div>
      </section>
    </>
  )
}

export default DashboardPage
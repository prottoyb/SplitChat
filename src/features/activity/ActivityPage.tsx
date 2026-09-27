function ActivityPage() {
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">ACTIVITY</p>
          <h2>Activity</h2>

          <p className="subtitle">
            Follow recent expenses, settlements and group activity.
          </p>
        </div>
      </header>

      <section className="panel">
        <div className="empty-state">
          <div className="empty-icon">◌</div>

          <h4>No recent activity</h4>

          <p>
            Activity from your groups and shared expenses will appear here.
          </p>
        </div>
      </section>
    </>
  )
}

export default ActivityPage
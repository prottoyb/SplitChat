function GroupsPage() {
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">GROUPS</p>
          <h2>Your groups</h2>

          <p className="subtitle">
            Create and manage groups for shared expenses and conversations.
          </p>
        </div>

        <button className="primary-button">+ Create group</button>
      </header>

      <section className="panel">
        <div className="empty-state">
          <div className="empty-icon">◎</div>

          <h4>No groups yet</h4>

          <p>
            Your SplitChat groups will appear here once you create or join one.
          </p>

          <button className="secondary-button">
            Create your first group
          </button>
        </div>
      </section>
    </>
  )
}

export default GroupsPage
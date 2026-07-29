export default function HomePage() {
  return (
    <main>
      <header>
        <p>控制台</p>
        <h1>百度云外呼一键配置</h1>
        <p>安全地准备、确认并跟踪每次外呼机器人配置。</p>
      </header>

      <section aria-labelledby="execution-list-heading">
        <h2 id="execution-list-heading">执行列表</h2>
        <p>暂无执行任务</p>
        <p>创建并确认配置草案后，才能在 Codex 中开始执行。</p>
        <button type="button" disabled>
          在 Codex 中开始执行
        </button>
      </section>
    </main>
  );
}

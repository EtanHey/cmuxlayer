export function Cta() {
  return (
    <section className="py-[100px] pb-20 text-center">
      <div className="max-w-[960px] mx-auto px-6">
        <h2 className="font-display text-[clamp(26px,4vw,42px)] font-semibold tracking-[-0.03em] mb-3">
          Stop being the clipboard.
        </h2>
        <p className="text-text-secondary text-[15px] mb-9 font-light">
          npm install. Add to MCP config. Start orchestrating.
        </p>
        <div className="flex items-center justify-center gap-3 max-[480px]:flex-col">
          <a
            href="#setup"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium no-underline cursor-pointer bg-text text-bg hover:scale-[1.03] active:scale-[0.98] transition-transform duration-150 hover:shadow-[0_0_24px_rgba(250,250,249,0.15)] max-[480px]:w-full max-[480px]:justify-center"
          >
            Get started
          </a>
          <a
            href="https://github.com/EtanHey/cmuxlayer"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium no-underline cursor-pointer bg-transparent text-text-secondary border border-border hover:text-text hover:border-border-hover hover:scale-[1.03] active:scale-[0.98] transition-all duration-150 max-[480px]:w-full max-[480px]:justify-center"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

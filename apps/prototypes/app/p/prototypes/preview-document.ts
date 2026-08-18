export const instrumentedPreviewDocument = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { color: #172033; background: #fff; font-family: Arial, sans-serif; }
      * { box-sizing: border-box; }
      html.annotating, html.annotating * {
        cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24'%3E%3Cpath d='M20 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4z' fill='%232563eb' stroke='%23ffffff' stroke-width='1.5' stroke-linejoin='round'/%3E%3C/svg%3E") 4 4, pointer !important;
      }
      body { margin: 0; min-width: 680px; }
      header { height: 56px; display: flex; align-items: center; border-bottom: 1px solid #e4e7ec; padding: 0 28px; }
      .brand { font-weight: 700; margin-right: auto; }
      nav { display: flex; gap: 8px; }
      button { border: 1px solid #cfd5df; background: #fff; border-radius: 7px; min-height: 34px; padding: 0 13px; color: inherit; cursor: pointer; }
      nav button { border: 0; color: #667085; }
      nav button.active { color: #172033; background: #f2f4f7; }
      .primary { border-color: #315efb; background: #315efb; color: #fff; }
      .page { max-width: 900px; margin: 0 auto; padding: 64px 36px; }
      .eyebrow { color: #315efb; font-size: 12px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
      h1 { margin: 12px 0 16px; font-size: 48px; line-height: 1.05; letter-spacing: -.035em; }
      h2 { margin: 0 0 10px; font-size: 22px; }
      p { color: #667085; line-height: 1.6; }
      .hero { max-width: 650px; }
      .actions { display: flex; gap: 10px; margin-top: 28px; }
      .card { border: 1px solid #e4e7ec; border-radius: 14px; padding: 28px; }
      .team { margin-top: 32px; background: #f8f9fb; }
      .contact { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
      label { display: grid; gap: 7px; margin-bottom: 16px; color: #344054; font-size: 13px; }
      input, textarea { width: 100%; border: 1px solid #cfd5df; border-radius: 7px; padding: 10px 12px; font: inherit; }
      textarea { min-height: 100px; resize: vertical; }
    </style>
  </head>
  <body>
    <main id="app"></main>

    <template id="home-page">
      <header>
        <span class="brand">Hello</span>
        <nav aria-label="Example pages">
          <button class="active" data-nav-route="/home">Home</button>
          <button data-nav-route="/about" data-min-version="7">About</button>
          <button data-nav-route="/contact" data-min-version="8">Contact</button>
        </nav>
      </header>
      <section class="page">
        <div class="hero">
          <div class="eyebrow">A tiny example app</div>
          <h1>Hello, world.</h1>
          <p>A simple place to explore pages, versions, and review comments.</p>
          <div class="actions">
            <button class="primary" data-anno-id="hello-primary-action" data-anno-label="Get started button" data-min-version="7" data-nav-route="/about">Get started</button>
            <button data-nav-route="/contact" data-min-version="8">Contact us</button>
          </div>
        </div>
      </section>
    </template>

    <template id="about-page">
      <header>
        <span class="brand">Hello</span>
        <nav aria-label="Example pages">
          <button data-nav-route="/home">Home</button>
          <button class="active" data-nav-route="/about">About</button>
          <button data-nav-route="/contact" data-min-version="8">Contact</button>
        </nav>
      </header>
      <section class="page">
        <div class="eyebrow">About</div>
        <h1>Nice to meet you.</h1>
        <p>This sample app exists only to make prototype review easy to understand.</p>
        <article class="card team">
          <h2>Our tiny team</h2>
          <p data-anno-id="hello-team-copy" data-anno-label="Team description">We are three curious people making a very small app with a surprisingly useful review workflow.</p>
        </article>
      </section>
    </template>

    <template id="contact-page">
      <header>
        <span class="brand">Hello</span>
        <nav aria-label="Example pages">
          <button data-nav-route="/home">Home</button>
          <button data-nav-route="/about">About</button>
          <button class="active" data-nav-route="/contact">Contact</button>
        </nav>
      </header>
      <section class="page contact">
        <div>
          <div class="eyebrow">Contact</div>
          <h1>Say hello.</h1>
          <p>This form is intentionally simple. In Preview mode it behaves like the app; in Comment mode it becomes reviewable DOM.</p>
        </div>
        <form class="card">
          <label>Name<input placeholder="Ada Lovelace" /></label>
          <label>Message<textarea placeholder="Hello there"></textarea></label>
          <button class="primary" type="submit">Send message</button>
        </form>
      </section>
    </template>

    <script>
      const app = document.getElementById('app');
      let annotationEnabled = false;
      let currentRoute = '/home';
      let currentVersion = 8;
      const post = (type, payload) => parent.postMessage({ source: 'closedloop-prototype-bridge', type, ...payload }, '*');
      const selectorFor = (element) => {
        const tag = element.tagName.toLowerCase();
        const id = element.dataset.annoId;
        return id ? tag + '[data-anno-id="' + id + '"]' : tag;
      };
      const describe = (element) => {
        const rect = element.getBoundingClientRect();
        const styles = getComputedStyle(element);
        return {
          anchorId: element.dataset.annoId,
          target: element.dataset.annoLabel || element.textContent.trim().slice(0, 80),
          selector: selectorFor(element),
          route: currentRoute,
          tagName: element.tagName.toLowerCase(),
          text: element.textContent.trim(),
          textColor: styles.color,
          background: styles.backgroundColor,
          opacity: styles.opacity,
          font: styles.fontFamily,
          html: element.outerHTML,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      };
      const reportLayout = () => post('layout', {
        route: currentRoute,
        version: currentVersion,
        anchors: [...app.querySelectorAll('[data-anno-id]')].map(describe)
      });
      const stampAnchors = () => {
        const routeKey = currentRoute.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
        [app, ...app.querySelectorAll('*')].forEach((element, index) => {
          if (!element.dataset.annoId) {
            element.dataset.annoId = 'auto-' + routeKey + '-' + index;
          }
          if (!element.dataset.annoLabel) {
            const text = element.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60);
            element.dataset.annoLabel = text
              ? element.tagName.toLowerCase() + ' · ' + text
              : element.tagName.toLowerCase();
          }
        });
      };
      const applyVersion = () => {
        app.querySelectorAll('[data-min-version]').forEach((element) => {
          if (currentVersion < Number(element.dataset.minVersion)) element.remove();
        });
      };
      const allowedRoute = (route) => {
        if (route === '/contact' && currentVersion < 8) return '/home';
        if (route === '/about' && currentVersion < 7) return '/home';
        return ['/home', '/about', '/contact'].includes(route) ? route : '/home';
      };
      const syncAnnotationFocus = () => {
        app.querySelectorAll('[data-anno-id]').forEach((element) => {
          const naturallyInteractive = element.matches(
            'a[href], button, input, select, textarea, [contenteditable="true"]'
          );
          if (
            annotationEnabled &&
            !naturallyInteractive &&
            !element.hasAttribute('tabindex')
          ) {
            element.dataset.annoManagedTabindex = 'true';
            element.tabIndex = 0;
          } else if (
            !annotationEnabled &&
            element.dataset.annoManagedTabindex === 'true'
          ) {
            element.removeAttribute('tabindex');
            delete element.dataset.annoManagedTabindex;
          }
        });
      };
      const renderRoute = (route, anchorId) => {
        currentRoute = allowedRoute(route);
        const templateId = currentRoute.slice(1) + '-page';
        app.replaceChildren(document.getElementById(templateId).content.cloneNode(true));
        applyVersion();
        stampAnchors();
        syncAnnotationFocus();
        requestAnimationFrame(() => {
          reportLayout();
          post('route', { route: currentRoute, version: currentVersion });
          if (anchorId) {
            const target = app.querySelector('[data-anno-id="' + anchorId + '"]');
            if (target) target.scrollIntoView({ block: 'center' });
          }
        });
      };
      addEventListener('message', (event) => {
        if (event.data?.source !== 'closedloop-prototype-host') return;
        if (event.data.type === 'mode') {
          annotationEnabled = Boolean(event.data.enabled);
          document.documentElement.classList.toggle('annotating', annotationEnabled);
          syncAnnotationFocus();
        }
        if (event.data.type === 'version') {
          currentVersion = Number(event.data.version);
          renderRoute(event.data.route || '/home', event.data.anchorId);
        }
        if (event.data.type === 'navigate') renderRoute(event.data.route, event.data.anchorId);
      });
      document.addEventListener('pointermove', (event) => {
        if (!annotationEnabled) return;
        const target = event.target.closest('[data-anno-id]');
        post('hover', { anchor: target ? describe(target) : null });
      });
      document.addEventListener('click', (event) => {
        if (annotationEnabled) {
          event.preventDefault();
          event.stopPropagation();
          const target = event.target.closest('[data-anno-id]');
          if (!target) {
            post('clear-selection', {});
            return;
          }
          post('select', { anchor: describe(target) });
          return;
        }
        const navigation = event.target.closest('[data-nav-route]');
        if (navigation) {
          event.preventDefault();
          renderRoute(navigation.dataset.navRoute);
        }
      }, true);
      document.addEventListener('keydown', (event) => {
        if (!annotationEnabled || !['Enter', ' '].includes(event.key)) return;
        const target = event.target.closest('[data-anno-id]');
        if (!target) return;
        event.preventDefault();
        post('select', { anchor: describe(target) });
      });
      document.addEventListener('submit', (event) => event.preventDefault());
      addEventListener('resize', reportLayout);
      addEventListener('scroll', reportLayout, true);
      renderRoute('/home');
      setTimeout(() => post('ready', {}), 0);
    </script>
  </body>
</html>`;

export function previewDocumentForVersion(version: number): string {
  return instrumentedPreviewDocument.replace(
    "let currentVersion = 8;",
    `let currentVersion = ${version};`
  );
}

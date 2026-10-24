/*
 * Warranty lookup for /warranty.
 *
 * Cards are issued by the Buyology backend (one per unit sold, when its order is delivered):
 *   GET {apiBaseUrl}/api/warranty/{serial}
 *   200 = { statusCode, message, data: card }
 *   card = { serialNumber, status, durationMonths, startDate, endDate, soldBy, coverage,
 *            product: { name, brand, category, condition, specs: [{ label, value }] } }
 *   404 = no card matches
 *
 * A page can override the defaults by defining window.DITHARI_WARRANTY_CONFIG before this script.
 * Deep link: /warranty?serial=XXXX fills the field and runs the lookup on load. Buyology's order
 * page links here that way.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);

  var CONFIG = Object.assign(
    {
      // The same API that serves buyology.online; it allows this site's origin for this lookup.
      apiBaseUrl: 'https://api.buyology.online',
      supportEmail: 'support@dithari.com',
      expiringSoonDays: 30
    },
    window.DITHARI_WARRANTY_CONFIG || {}
  );

  var DAY_MS = 24 * 60 * 60 * 1000;

  /* ------------------------------------------------------------------ */
  /* Data access                                                         */
  /* ------------------------------------------------------------------ */

  function fetchWarranty(serial) {
    var url = CONFIG.apiBaseUrl.replace(/\/+$/, '') + '/api/warranty/' + encodeURIComponent(serial);
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('Warranty lookup failed with HTTP ' + res.status);
      // The backend wraps every response as { statusCode, message, data }.
      return res.json().then(function (body) {
        return body && body.data ? body.data : null;
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function startOfToday() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Parse YYYY-MM-DD as a local date so it never shifts a day across time zones.
  function parseIsoDate(value) {
    if (!value) return null;
    var parts = String(value).slice(0, 10).split('-');
    if (parts.length !== 3) return null;
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  var dateFormatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  function formatDate(value) {
    var d = parseIsoDate(value);
    return d ? dateFormatter.format(d) : '—';
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function formatDuration(months) {
    if (!months) return '—';
    return months % 12 === 0 ? plural(months / 12, 'year') : plural(months, 'month');
  }

  // The backend's rule too (WarrantySerials.canonicalize): case, spaces and missing dashes do not
  // matter, and O/I/L in the twelve random characters are read as 0/1 — our serials never
  // contain those letters, so a misread card still finds its warranty.
  function normalizeSerial(raw) {
    var cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/^DTH[A-Z0-9]{12}$/.test(cleaned)) {
      var body = cleaned.slice(3).replace(/O/g, '0').replace(/[IL]/g, '1');
      return 'DTH-' + body.slice(0, 4) + '-' + body.slice(4, 8) + '-' + body.slice(8);
    }
    return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  function validateSerial(serial) {
    if (!serial) return 'Enter the serial number from your warranty card.';
    if (serial.length < 6 || serial.length > 64 || !/^[A-Z0-9-]+$/.test(serial)) {
      return 'That doesn’t look like a valid serial number. Serial numbers use letters, numbers and dashes.';
    }
    return '';
  }

  var STATUS_META = {
    ACTIVE: { label: 'Active', className: 'is-active' },
    EXPIRING_SOON: { label: 'Expiring soon', className: 'is-expiring' },
    EXPIRED: { label: 'Expired', className: 'is-expired' },
    VOID: { label: 'Void', className: 'is-void' }
  };

  function deriveTimeline(warranty) {
    var start = parseIsoDate(warranty.startDate);
    var end = parseIsoDate(warranty.endDate);
    var today = startOfToday();
    var daysLeft = end ? Math.round((end - today) / DAY_MS) : null;
    var remaining = 0;
    if (start && end && end > start) {
      remaining = Math.min(1, Math.max(0, (end - today) / (end - start)));
    }

    // The backend status wins; dates are the fallback when it is missing.
    var status = warranty.status;
    if (!STATUS_META[status]) {
      if (daysLeft === null || daysLeft < 0) status = 'EXPIRED';
      else if (daysLeft <= CONFIG.expiringSoonDays) status = 'EXPIRING_SOON';
      else status = 'ACTIVE';
    }
    if (status === 'EXPIRED' || status === 'VOID') remaining = 0;

    return { status: status, daysLeft: daysLeft, remaining: remaining };
  }

  // Small DOM builder. Text always goes through textContent, never innerHTML.
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  var form = document.getElementById('warranty-form');
  var input = document.getElementById('warranty-serial');
  var submit = document.getElementById('warranty-submit');
  var submitLabel = document.getElementById('warranty-submit-label');
  var formError = document.getElementById('warranty-form-error');
  var result = document.getElementById('warranty-result');
  var lookupCount = 0;

  function setLoading(loading) {
    submit.disabled = loading;
    submitLabel.textContent = loading ? 'Checking…' : 'Check warranty';
    result.setAttribute('aria-busy', loading ? 'true' : 'false');
  }

  function showResult(node) {
    result.replaceChildren(node);
    var heading = result.querySelector('[data-focus-target]');
    if (heading) heading.focus({ preventScroll: true });
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderLoading() {
    result.replaceChildren(el('div', { className: 'warranty-skeleton', 'aria-hidden': 'true' }));
  }

  function renderCard(warranty, timeline) {
    var product = warranty.product || {};
    var meta = STATUS_META[timeline.status];
    var tags = [product.brand, product.category, product.condition].filter(Boolean);
    var specs = (product.specs || []).filter(function (s) { return s && s.label && s.value; });

    var progressText;
    if (timeline.status === 'VOID') progressText = 'Not valid';
    else if (timeline.status === 'EXPIRED' || timeline.daysLeft < 0) progressText = 'Coverage ended';
    else progressText = plural(timeline.daysLeft, 'day') + ' left';

    return el('article', { className: 'warranty-card', 'aria-label': 'Digital warranty card' }, [
      el('div', { className: 'warranty-card-top' }, [
        el('div', { className: 'warranty-card-brand' }, [
          el('img', { className: 'warranty-card-logo', src: 'images/683ec579fb2fbad91b8dd281_dithari-20logo.svg', alt: 'Dithari' }),
          el('span', { className: 'warranty-card-brand-divider', 'aria-hidden': 'true' }),
          el('div', { className: 'label', text: 'Digital warranty card' })
        ]),
        el('span', { className: 'warranty-status ' + meta.className, text: meta.label })
      ]),
      el('div', { className: 'warranty-card-product' }, [
        el('h2', { className: 'warranty-card-name', text: product.name || 'Unnamed product', tabindex: '-1', 'data-focus-target': '' }),
        tags.length ? el('div', { className: 'warranty-card-meta' }, tags.map(function (t) {
          return el('span', { className: 'warranty-card-tag', text: t });
        })) : null
      ]),
      specs.length ? el('dl', { className: 'warranty-specs' }, specs.map(function (s) {
        return el('div', { className: 'warranty-spec' }, [
          el('dt', { text: s.label }),
          el('dd', { text: s.value })
        ]);
      })) : null,
      el('div', { className: 'warranty-progress' }, [
        el('div', { className: 'warranty-progress-head' }, [
          el('span', { text: 'Coverage remaining' }),
          el('span', { text: progressText })
        ]),
        el('div', {
          className: 'warranty-progress-track',
          role: 'progressbar',
          'aria-label': 'Coverage remaining',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(Math.round(timeline.remaining * 100))
        }, [
          el('div', { className: 'warranty-progress-fill', style: 'width: 0%', 'data-width': (timeline.remaining * 100).toFixed(1) + '%' })
        ])
      ]),
      el('div', { className: 'warranty-card-bottom' }, [
        el('div', { className: 'warranty-card-field' }, [
          el('div', { className: 'label', text: 'Serial number' }),
          el('div', { className: 'warranty-card-field-value warranty-serial', text: warranty.serialNumber })
        ]),
        el('div', { className: 'warranty-card-field' }, [
          el('div', { className: 'label', text: 'Valid from' }),
          el('div', { className: 'warranty-card-field-value', text: formatDate(warranty.startDate) })
        ]),
        el('div', { className: 'warranty-card-field' }, [
          el('div', { className: 'label', text: 'Valid until' }),
          el('div', { className: 'warranty-card-field-value', text: formatDate(warranty.endDate) })
        ])
      ])
    ]);
  }

  function serviceMailto(warranty) {
    var product = warranty.product || {};
    var subject = 'Warranty service request – ' + warranty.serialNumber;
    var body = 'Serial number: ' + warranty.serialNumber + '\n' +
      'Product: ' + (product.name || '') + '\n\n' +
      'Please describe the issue:\n';
    return 'mailto:' + CONFIG.supportEmail + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  var PANEL_COPY = {
    ACTIVE: function (w) {
      return { title: 'Your warranty is active', message: 'This product is covered until ' + formatDate(w.endDate) + '.' };
    },
    EXPIRING_SOON: function (w) {
      return { title: 'Your warranty ends soon', message: 'Coverage ends on ' + formatDate(w.endDate) + '. Raise any issue before then.' };
    },
    EXPIRED: function (w) {
      return { title: 'This warranty has expired', message: 'Coverage ended on ' + formatDate(w.endDate) + '. Our support team can still help if something is wrong with your product.' };
    },
    VOID: function () {
      return { title: 'This warranty is no longer valid', message: 'This card has been voided, usually after a return or refund. Contact support if this looks wrong.' };
    }
  };

  function renderPanel(warranty, timeline) {
    var copy = PANEL_COPY[timeline.status](warranty);
    var covered = timeline.status === 'ACTIVE' || timeline.status === 'EXPIRING_SOON';

    var facts = [
      ['Warranty period', formatDuration(warranty.durationMonths)],
      ['Start date', formatDate(warranty.startDate)],
      ['End date', formatDate(warranty.endDate)]
    ];
    if (covered) facts.push(['Days remaining', String(Math.max(0, timeline.daysLeft))]);
    if (warranty.soldBy) facts.push(['Sold by', warranty.soldBy]);

    return el('aside', { className: 'warranty-panel', 'aria-label': 'Warranty details' }, [
      el('div', null, [
        el('h3', { className: 'warranty-panel-title', text: copy.title }),
        el('p', { className: 'text-body warranty-panel-message', text: copy.message })
      ]),
      el('dl', { className: 'warranty-facts' }, facts.map(function (f) {
        return el('div', { className: 'warranty-fact' }, [el('dt', { text: f[0] }), el('dd', { text: f[1] })]);
      })),
      warranty.coverage ? el('div', { className: 'warranty-coverage' }, [
        el('div', { className: 'label', text: 'What’s covered' }),
        el('p', { className: 'text-body', text: warranty.coverage })
      ]) : null,
      el('div', { className: 'warranty-actions' }, [
        covered
          ? el('a', { className: 'warranty-action is-primary', href: serviceMailto(warranty), text: 'Request warranty service' })
          : el('a', { className: 'warranty-action is-primary', href: '/contact', text: 'Contact support' }),
        el('button', { className: 'warranty-action', type: 'button', text: 'Save or print card', onclick: function () { window.print(); } })
      ])
    ]);
  }

  function renderFound(warranty) {
    var timeline = deriveTimeline(warranty);
    var grid = el('div', { className: 'warranty-result-grid' }, [
      renderCard(warranty, timeline),
      renderPanel(warranty, timeline)
    ]);
    showResult(grid);
    // Animate the coverage bar after it is in the DOM.
    requestAnimationFrame(function () {
      var fill = grid.querySelector('.warranty-progress-fill');
      if (fill) fill.style.width = fill.getAttribute('data-width');
    });
  }

  function messageIcon(path) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    p.setAttribute('stroke', '#084734');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return el('div', { className: 'warranty-message-icon' }, [svg]);
  }

  function renderNotFound(serial) {
    showResult(el('div', { className: 'warranty-message-card' }, [
      messageIcon('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4-4'),
      el('div', { className: 'warranty-message-body' }, [
        el('h2', { className: 'warranty-panel-title', text: 'We couldn’t find that serial number', tabindex: '-1', 'data-focus-target': '' }),
        el('p', { className: 'text-body' }, ['No warranty card matches ', el('strong', { className: 'warranty-serial', text: serial }), '.']),
        el('ul', null, [
          el('li', { text: 'Check the serial for typos. It starts with DTH and has three groups of four characters.' }),
          el('li', { text: 'Use the serial from your warranty card or your order details, not the product model number.' })
        ]),
        el('div', { className: 'warranty-actions' }, [
          el('a', { className: 'warranty-action is-primary', href: '/contact', text: 'Contact support' }),
          el('button', { className: 'warranty-action', type: 'button', text: 'Try another serial', onclick: focusInput })
        ])
      ])
    ]));
  }

  function renderError(serial) {
    showResult(el('div', { className: 'warranty-message-card', role: 'alert' }, [
      messageIcon('M12 8v5m0 3h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'),
      el('div', { className: 'warranty-message-body' }, [
        el('h2', { className: 'warranty-panel-title', text: 'We couldn’t check your warranty right now', tabindex: '-1', 'data-focus-target': '' }),
        el('p', { className: 'text-body', text: 'Something went wrong on our side. Please try again in a moment.' }),
        el('div', { className: 'warranty-actions' }, [
          el('button', { className: 'warranty-action is-primary', type: 'button', text: 'Try again', onclick: function () { lookup(serial); } }),
          el('a', { className: 'warranty-action', href: '/contact', text: 'Contact support' })
        ])
      ])
    ]));
  }

  function focusInput() {
    input.focus();
    input.select();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ------------------------------------------------------------------ */
  /* Lookup flow                                                         */
  /* ------------------------------------------------------------------ */

  function setFormError(message) {
    formError.textContent = message;
    input.classList.toggle('is-invalid', Boolean(message));
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function updateUrl(serial) {
    var url = new URL(window.location.href);
    url.searchParams.set('serial', serial);
    window.history.replaceState(null, '', url);
  }

  function lookup(serial) {
    var id = ++lookupCount;
    setFormError('');
    setLoading(true);
    renderLoading();
    updateUrl(serial);

    fetchWarranty(serial)
      .then(function (warranty) {
        if (id !== lookupCount) return;
        if (warranty) renderFound(warranty);
        else renderNotFound(serial);
      })
      .catch(function (err) {
        if (id !== lookupCount) return;
        console.error(err);
        renderError(serial);
      })
      .then(function () {
        if (id === lookupCount) setLoading(false);
      });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var serial = normalizeSerial(input.value);
    var problem = validateSerial(serial);
    if (problem) {
      setFormError(problem);
      input.focus();
      return;
    }
    input.value = serial;
    lookup(serial);
  });

  input.addEventListener('input', function () {
    if (formError.textContent) setFormError('');
  });

  var initialSerial = normalizeSerial(params.get('serial'));
  if (initialSerial) {
    input.value = initialSerial;
    var initialProblem = validateSerial(initialSerial);
    if (initialProblem) setFormError(initialProblem);
    else lookup(initialSerial);
  }
})();

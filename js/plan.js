/*
 * Lesson plans: the teacher's builder (teacher.html) and the student's plan page (plan.html).
 *
 * A plan is a title, an introduction, a list of the site's pages with a note each, the code
 * language and whether lesson mode is on. It lives in the link (see window.dsvPlan in
 * js/layout.js, which also draws the plan bar on the pages); nothing is stored on a server.
 * The teacher's texts are always put in the page as text, never as HTML.
 *
 * Runs after js/layout.js (window.dsvExamples, window.dsvPlan).
 */
(function(){
	var dsv = window.dsv, t = dsv.t, lang = dsv.settings.lang;
	var PLAN = window.dsvPlan, EXAMPLES = window.dsvExamples || [];
	var root = document.getElementById('plan-app');
	var kind = document.querySelector('main.lesson').getAttribute('data-plan-page');
	if(!root || !PLAN)
		return;

	function pick(texts){ return texts[lang] || texts.tr; }
	function el(tag, attrs, text){
		var e = document.createElement(tag);
		Object.keys(attrs || {}).forEach(function(k){ if(k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); });
		if(text !== undefined) e.textContent = text;
		return e;
	}
	function groupOf(file){
		var found = '';
		EXAMPLES.forEach(function(g){ g.items.forEach(function(it){ if(it[0] === file) found = pick(g.group); }); });
		return found;
	}
	function titleOf(file){ return PLAN.known[file] ? PLAN.known[file].title : file; }
	var CODE_NAMES = {dugum: 'Düğüm', turkce: 'Düğüm (Türkçe)', cpp: 'C++', java: 'Java'};

	var toastTimer = null;
	function toast(text){
		var box = document.getElementById('dsv-toast');
		if(!box){
			box = el('div', {'class': 'dsv-toast', id: 'dsv-toast', role: 'status'});
			document.body.appendChild(box);
		}
		box.textContent = text;
		box.classList.add('show');
		clearTimeout(toastTimer);
		toastTimer = setTimeout(function(){ box.classList.remove('show'); }, 2500);
	}
	function copy(text, message){
		var manual = function(){ window.prompt(t('shareManual'), text); };
		if(navigator.clipboard && navigator.clipboard.writeText)
			navigator.clipboard.writeText(text).then(function(){ toast(message); }, manual);
		else
			manual();
	}
	function planUrl(plan){
		var base = new URL('plan.html', location.href).href.split('#')[0];
		return base + '#plan=' + PLAN.encode(plan) + (plan.c ? '&c=' + plan.c : '');
	}

	// ---------------------------------------------------------------------- ready-made plans
	function note(tr, en, de){ return {tr: tr, en: en, de: de}; }
	var PRESETS = [
		{name: note('Bağlı listeler', 'Linked lists', 'Verkettete Listen'),
		 intro: note('Bu derste bağlı listeyi baştan sona çalışıyoruz: dolaşma, ekleme, silme ve pointer teknikleri.', 'In this lesson we work through the linked list from start to end: traversal, insertion, deletion and pointer techniques.', 'In dieser Lektion arbeiten wir die verkettete Liste von vorn bis hinten durch: Durchlaufen, Einfügen, Löschen und Zeigertechniken.'),
		 files: ['lengthOfALinkedList.html', 'sumMaxAndSearchInALinkedList.html', 'insertAtTheHeadOfALinkedList.html', 'appendAnItemOnTheLinkedList.html', 'deleteANodeFromALinkedList.html', 'reverseALinkedList.html', 'findTheMiddleOfALinkedList.html', 'kthNodeFromTheEnd.html', 'detectACycleInALinkedList.html'],
		 notes: {'reverseALinkedList.html': note('Çalıştırmadan önce üç pointer\'ın her adımda nereye gideceğini kâğıtta tahmin edin, sonra adım adım karşılaştırın.', 'Before running, predict on paper where the three pointers go in every step, then compare step by step.', 'Sagen Sie vor dem Ausführen auf Papier voraus, wohin die drei Zeiger in jedem Schritt wandern, und vergleichen Sie dann Schritt für Schritt.')}},
		{name: note('Yığın, kuyruk ve özyineleme', 'Stacks, queues and recursion', 'Stapel, Warteschlangen und Rekursion'),
		 intro: note('Son giren ilk çıkar, ilk giren ilk çıkar ve bir fonksiyonun kendini çağırması.', 'Last in first out, first in first out, and a function calling itself.', 'Zuletzt hinein zuerst hinaus, zuerst hinein zuerst hinaus und eine Funktion, die sich selbst aufruft.'),
		 files: ['stack.html', 'queue.html', 'arrayStackQueue.html', 'functions.html', 'recursion.html'],
		 notes: {'recursion.html': note('Çağrı yığını panelini açık tutun: her çağrı yığına yeni bir çerçeve ekler.', 'Keep the call stack panel open: every call adds a new frame to the stack.', 'Lassen Sie den Aufrufstapel-Bereich offen: jeder Aufruf legt einen neuen Rahmen auf den Stapel.')}},
		{name: note('Arama ve sıralama', 'Searching and sorting', 'Suchen und Sortieren'),
		 intro: note('Aynı işi yapan algoritmaları karşılaştırma sayacıyla kıyaslıyoruz: hangisi neden daha hızlı?', 'We compare algorithms that do the same job with the comparison counter: which is faster, and why?', 'Wir vergleichen Algorithmen, die dieselbe Aufgabe lösen, mit dem Vergleichszähler: welcher ist schneller und warum?'),
		 files: ['binarySearch.html', 'selectionSort.html', 'arrayBubbleSort.html', 'arrayInsertionSort.html', 'mergeSort.html', 'quickSort.html', 'heapSort.html', 'countingSort.html', 'sortComparison.html'],
		 notes: {'binarySearch.html': note('Karşılaştırma sayacını doğrusal aramayla kıyaslayın: kaça karşı kaç?', 'Compare the comparison counter with linear search: how many against how many?', 'Vergleichen Sie den Vergleichszähler mit der linearen Suche: wie viele gegen wie viele?'),
		          'quickSort.html': note('Pivotu aralığın ilk elemanı yapıp karşılaştırma sayısının nasıl değiştiğine bakın.', 'Make the pivot the first element of the range and see how the number of comparisons changes.', 'Machen Sie das erste Element des Bereichs zum Pivot und sehen Sie, wie sich die Zahl der Vergleiche ändert.')}},
		{name: note('Ağaçlar, heap ve hash tablosu', 'Trees, heaps and hash tables', 'Bäume, Heaps und Hashtabellen'),
		 intro: note('İkili arama ağacından dengeli ağaçlara, heap\'ten hash tablosuna.', 'From the binary search tree to balanced trees, from the heap to the hash table.', 'Vom binären Suchbaum zu ausgeglichenen Bäumen, vom Heap zur Hashtabelle.'),
		 files: ['binarySearchTree.html', 'treeTraversal.html', 'treeDelete.html', 'avlTree.html', 'heap.html', 'hashTable.html'], notes: {}},
		{name: note('Graflar', 'Graphs', 'Graphen'),
		 intro: note('Komşuluk listesinden en kısa yollara ve en küçük kapsayan ağaca.', 'From the adjacency list to shortest paths and the minimum spanning tree.', 'Von der Adjazenzliste zu kürzesten Wegen und dem minimalen Spannbaum.'),
		 files: ['graph.html', 'dijkstra.html', 'bellmanFord.html', 'topologicalSort.html', 'connectedComponents.html', 'unionFind.html', 'kruskal.html', 'prim.html'],
		 notes: {'kruskal.html': note('Önce kâğıtta elle çözün, sonra çalıştırıp seçilen kenarları karşılaştırın.', 'Solve it by hand on paper first, then run it and compare the chosen edges.', 'Lösen Sie es zuerst von Hand auf Papier, führen Sie es dann aus und vergleichen Sie die gewählten Kanten.')}},
		{name: note('Dönem özeti: veri yapıları ve algoritmalar', 'Semester overview: data structures and algorithms', 'Semesterüberblick: Datenstrukturen und Algorithmen'),
		 intro: note('Dönemin ana konuları, sırayla.', 'The main topics of the semester, in order.', 'Die Hauptthemen des Semesters, der Reihe nach.'),
		 files: ['language.html', 'reverseALinkedList.html', 'doublyLinkedList.html', 'stack.html', 'queue.html', 'recursion.html', 'binarySearch.html', 'mergeSort.html', 'quickSort.html', 'binarySearchTree.html', 'avlTree.html', 'heap.html', 'hashTable.html', 'graph.html', 'dijkstra.html'], notes: {}}
	];

	// ---------------------------------------------------------------------- the teacher's builder
	function buildTeacher(){
		var DRAFT = 'dsv-plan-draft';
		var state = {t: '', d: '', items: [], c: '', m: 0};
		var loaded = false;

		var fromLink = PLAN.fromHash(location.hash);
		if(fromLink){
			state = {t: fromLink.plan.t, d: fromLink.plan.d, items: fromLink.plan.items, c: fromLink.plan.c, m: fromLink.plan.m};
			loaded = true;
		}
		else {
			try {
				var draft = JSON.parse(localStorage.getItem(DRAFT) || 'null');
				if(draft && draft.items instanceof Array){
					var cleaned = PLAN.parse(PLAN.encode({t: draft.t, d: draft.d, items: draft.items, c: draft.c, m: draft.m}));
					if(cleaned) state = {t: cleaned.t, d: cleaned.d, items: cleaned.items, c: cleaned.c, m: cleaned.m};
				}
			} catch(e) {}
		}
		function save(){ try { localStorage.setItem(DRAFT, JSON.stringify(state)); } catch(e) {} }

		// ---- the form
		var intro = el('div', {'class': 'tp-loaded tp-help'}, loaded ? t('tpLoaded') : '');
		intro.hidden = !loaded;
		root.appendChild(intro);

		function field(labelKey, control){
			var label = el('label', {'class': 'tp-field'});
			label.appendChild(el('span', {}, t(labelKey)));
			label.appendChild(control);
			return label;
		}
		var title = el('input', {type: 'text', maxlength: '120', placeholder: t('tpTitlePh'), 'data-field': 'title'});
		title.value = state.t;
		var introBox = el('textarea', {maxlength: '1500', placeholder: t('tpIntroPh'), 'data-field': 'intro'});
		introBox.value = state.d;
		root.appendChild(field('tpTitleLabel', title));
		root.appendChild(field('tpIntroLabel', introBox));

		var row = el('div', {'class': 'tp-row'});
		var codeLabel = el('label', {'class': 'tp-field'});
		codeLabel.style.margin = '0';
		codeLabel.appendChild(el('span', {}, t('tpCodeLabel')));
		var code = el('select', {'data-field': 'code'});
		[['', t('tpCodeStudent')], ['dugum', 'Düğüm'], ['turkce', 'Düğüm (Türkçe)'], ['cpp', 'C++'], ['java', 'Java']].forEach(function(o){
			var op = el('option', {value: o[0]}, o[1]);
			if(o[0] === state.c) op.selected = true;
			code.appendChild(op);
		});
		codeLabel.appendChild(code);
		row.appendChild(codeLabel);
		var lessonLabel = el('label', {});
		var lessonBox = el('input', {type: 'checkbox', 'data-field': 'lesson'});
		lessonBox.checked = !!state.m;
		lessonLabel.appendChild(lessonBox);
		lessonLabel.appendChild(document.createTextNode(t('tpLessonMode')));
		row.appendChild(lessonLabel);
		root.appendChild(row);

		// ---- ready-made plans
		root.appendChild(el('h2', {}, t('tpPresets')));
		var chips = el('div', {'class': 'tp-presets'});
		PRESETS.forEach(function(p, i){ chips.appendChild(el('button', {type: 'button', 'class': 'tp-chip', 'data-preset': String(i)}, pick(p.name))); });
		root.appendChild(chips);
		root.appendChild(el('p', {'class': 'tp-help'}, t('tpPresetNote')));

		// ---- catalog and plan side by side
		var cols = el('div', {'class': 'tp-cols'});
		var catalogBox = el('div', {'class': 'tp-box'});
		catalogBox.appendChild(el('h2', {}, t('tpCatalog')));
		var catalog = el('div', {id: 'tp-catalog'});
		catalogBox.appendChild(catalog);
		var planBox = el('div', {'class': 'tp-box'});
		var planHead = el('h2', {});
		planBox.appendChild(planHead);
		var list = el('div', {id: 'tp-list'});
		planBox.appendChild(list);
		var clear = el('button', {type: 'button', 'class': 'tp-btn', 'data-clear': '1'}, t('tpClear'));
		planBox.appendChild(clear);
		cols.appendChild(catalogBox);
		cols.appendChild(planBox);
		root.appendChild(cols);

		// ---- the link
		var linkBox = el('div', {'class': 'tp-linkbox tp-box'});
		linkBox.appendChild(el('h2', {}, t('tpLink')));
		var linkInput = el('input', {type: 'text', readonly: '', 'aria-label': t('tpLink'), id: 'tp-link'});
		var linkWrap = el('div', {'class': 'tp-linkbox'});
		linkWrap.style.marginTop = '0';
		linkWrap.appendChild(linkInput);
		linkBox.appendChild(linkWrap);
		var warn = el('div', {'class': 'tp-warn'});
		warn.hidden = true;
		linkBox.appendChild(warn);
		var linkRow = el('div', {'class': 'tp-row'});
		var copyBtn = el('button', {type: 'button', 'class': 'tp-btn primary', id: 'tp-copy'}, t('tpCopy'));
		var openLink = el('a', {'class': 'tp-btn', id: 'tp-open', target: '_blank', rel: 'noopener'}, t('tpOpen'));
		openLink.style.textDecoration = 'none';
		linkRow.appendChild(copyBtn);
		linkRow.appendChild(openLink);
		var classLink = el('a', {'class': 'tp-btn', id: 'tp-class'}, t('tpClass'));   // the teacher's class page, with this plan
		classLink.style.textDecoration = 'none';
		linkRow.appendChild(classLink);
		linkBox.appendChild(linkRow);
		root.appendChild(linkBox);

		// ---- drawing
		function renderCatalog(){
			var open = {};
			Array.prototype.forEach.call(catalog.querySelectorAll('details'), function(d){ if(d.open) open[d.getAttribute('data-group')] = true; });
			catalog.textContent = '';
			var inPlan = {};
			state.items.forEach(function(x){ inPlan[x.file] = true; });
			EXAMPLES.forEach(function(g){
				var key = g.items[0][0];
				var d = el('details', {'data-group': key});
				if(open[key]) d.open = true;
				d.appendChild(el('summary', {}, pick(g.group)));
				g.items.forEach(function(it){
					var rowEl = el('div', {'class': 'tp-page'});
					rowEl.appendChild(el('span', {}, pick(it[1])));
					var add = el('button', {type: 'button', 'class': 'tp-btn', 'data-add': it[0]}, inPlan[it[0]] ? t('tpAdded') : t('tpAdd'));
					add.disabled = !!inPlan[it[0]];
					rowEl.appendChild(add);
					d.appendChild(rowEl);
				});
				catalog.appendChild(d);
			});
		}
		function renderList(){
			list.textContent = '';
			planHead.textContent = t('tpPlanList') + ' · ' + t('tpCount', {n: state.items.length});
			clear.hidden = !state.items.length;
			if(!state.items.length){
				list.appendChild(el('div', {'class': 'tp-empty'}, t('tpEmpty')));
				return;
			}
			state.items.forEach(function(x, i){
				var item = el('div', {'class': 'tp-item', 'data-index': String(i)});
				var head = el('div', {'class': 'tp-item-head'});
				head.appendChild(el('span', {'class': 'tp-no'}, String(i + 1)));
				head.appendChild(el('span', {'class': 'tp-name'}, titleOf(x.file)));
				var up = el('button', {type: 'button', 'class': 'tp-btn', 'data-up': String(i), 'aria-label': t('tpUp'), title: t('tpUp')}, '↑');
				up.disabled = i === 0;
				var down = el('button', {type: 'button', 'class': 'tp-btn', 'data-down': String(i), 'aria-label': t('tpDown'), title: t('tpDown')}, '↓');
				down.disabled = i === state.items.length - 1;
				head.appendChild(up);
				head.appendChild(down);
				head.appendChild(el('button', {type: 'button', 'class': 'tp-btn', 'data-remove': String(i), 'aria-label': t('tpRemove'), title: t('tpRemove')}, '✕'));
				item.appendChild(head);
				var noteBox = el('input', {type: 'text', 'class': 'tp-note', maxlength: '600', placeholder: t('tpNotePh'), 'data-note': String(i)});
				noteBox.value = x.note || '';
				item.appendChild(noteBox);
				list.appendChild(item);
			});
		}
		function renderLink(){
			var url = state.items.length ? planUrl(state) : '';
			linkInput.value = url;
			openLink.href = url || '#';
			classLink.href = url ? 'class.html#' + url.slice(url.indexOf('#') + 1) : '#';
			classLink.style.pointerEvents = url ? '' : 'none';
			classLink.style.opacity = url ? '' : '.45';
			copyBtn.disabled = !url;
			openLink.style.pointerEvents = url ? '' : 'none';
			openLink.style.opacity = url ? '' : '.45';
			var long = url.length > 4000;
			warn.hidden = !long;
			warn.textContent = long ? t('tpLongWarn', {n: url.length}) : '';
		}
		function changed(){ save(); renderLink(); }
		function all(){ renderCatalog(); renderList(); changed(); }

		// ---- events
		title.addEventListener('input', function(){ state.t = title.value; changed(); });
		introBox.addEventListener('input', function(){ state.d = introBox.value; changed(); });
		code.addEventListener('change', function(){ state.c = code.value; changed(); });
		lessonBox.addEventListener('change', function(){ state.m = lessonBox.checked ? 1 : 0; changed(); });
		list.addEventListener('input', function(e){
			var i = e.target.getAttribute && e.target.getAttribute('data-note');
			if(i !== null && i !== undefined && state.items[Number(i)]){ state.items[Number(i)].note = e.target.value; changed(); }
		});
		root.addEventListener('click', function(e){
			var b = e.target.closest && e.target.closest('button');
			if(!b) return;
			var add = b.getAttribute('data-add'), up = b.getAttribute('data-up'), down = b.getAttribute('data-down'),
			    remove = b.getAttribute('data-remove'), preset = b.getAttribute('data-preset');
			if(add && PLAN.known[add] && !state.items.some(function(x){ return x.file === add; })){
				state.items.push({file: add, note: ''});
				all();
			}
			else if(up !== null && Number(up) > 0){
				var a = Number(up); state.items.splice(a - 1, 0, state.items.splice(a, 1)[0]); renderList(); changed();
			}
			else if(down !== null && Number(down) < state.items.length - 1){
				var d = Number(down); state.items.splice(d + 1, 0, state.items.splice(d, 1)[0]); renderList(); changed();
			}
			else if(remove !== null){
				state.items.splice(Number(remove), 1);
				all();
			}
			else if(preset !== null){
				var p = PRESETS[Number(preset)];
				state.items = p.files.filter(function(f){ return PLAN.known[f]; }).map(function(f){ return {file: f, note: p.notes[f] ? pick(p.notes[f]) : ''}; });
				if(!state.t) { state.t = pick(p.name); title.value = state.t; }
				if(!state.d) { state.d = pick(p.intro); introBox.value = state.d; }
				all();
			}
			else if(b.getAttribute('data-clear')){
				state.items = [];
				all();
			}
			else if(b.id === 'tp-copy' && linkInput.value)
				copy(linkInput.value, t('tpCopied'));
		});
		linkInput.addEventListener('focus', function(){ linkInput.select(); });
		all();
		window.dsvTeacherState = function(){ return JSON.parse(JSON.stringify(state)); }; // for the tests
	}

	// ---------------------------------------------------------------------- the class of a plan link (class=CODE)
	// The student joins with a nickname; then the checks of this plan's exercises go to the teacher
	// (js/classroom.js, js/exercise.js). Nothing is requested before the student presses "join".
	function classBox(found){
		var m = /(?:^#|&)class=([A-Z0-9]{6})(?:&|$)/.exec(location.hash), C = window.dsvClassroom;
		if(!m) return;
		var code = m[1];
		var box = el('div', {'class': 'tp-box pp-class', id: 'pp-class'});
		root.appendChild(box);
		function msg(text){ var p = box.querySelector('.pp-class-msg'); if(p) p.textContent = text || ''; }
		function draw(){
			box.textContent = '';
			box.appendChild(el('h2', {}, t('ppClassTitle')));
			if(!C || !C.enabled()){ box.appendChild(el('p', {}, t('ppClassOff'))); return; }
			var me = C.membership();
			if(me && me.code === code){
				box.appendChild(el('p', {id: 'pp-member'}, t('ppMember', {name: me.className || code, nick: me.nick})));
				var row = el('div', {'class': 'tp-row'});
				var change = el('button', {type: 'button', 'class': 'tp-btn', id: 'pp-change'}, t('ppChange'));
				var leave = el('button', {type: 'button', 'class': 'tp-btn', id: 'pp-leave'}, t('ppLeave'));
				var wipe = el('button', {type: 'button', 'class': 'tp-btn danger', id: 'pp-leave-delete'}, t('ppLeaveDelete'));
				change.addEventListener('click', function(){ C.leave(false).then(draw); });
				leave.addEventListener('click', function(){ C.leave(false).then(draw); });
				wipe.addEventListener('click', function(){ C.leave(true).then(draw); });
				[change, leave, wipe].forEach(function(b){ row.appendChild(b); });
				box.appendChild(row);
				return;
			}
			box.appendChild(el('p', {}, t('ppClassCode', {code: code})));
			var nick = el('input', {type: 'text', id: 'pp-nick', maxlength: '30', placeholder: t('ppNick'), 'aria-label': t('ppNick'), 'class': 'pp-nick'});
			var join = el('button', {type: 'button', 'class': 'tp-btn primary', id: 'pp-join-btn'}, t('ppJoin'));
			box.appendChild(nick);
			box.appendChild(join);
			box.appendChild(el('p', {'class': 'pp-class-msg', role: 'status', 'aria-live': 'polite'}));
			join.addEventListener('click', function(){
				if(!nick.value.trim()) return nick.focus();
				var other = C.membership();
				var ready = Promise.resolve();
				if(other && other.code !== code){
					if(!window.confirm(t('ppSwitchQ', {name: other.className || other.code}))) return;
					ready = C.leave(false);
				}
				join.disabled = true;
				ready.then(function(){ return C.join(code, nick.value.trim()); }).then(draw, function(e){
					join.disabled = false;
					msg(e && e.code === 'not-found' ? t('ppJoinNoClass') : e && e.code === 'denied' ? t('ppJoinClosed') : t('clErrNetwork'));
				});
			});
		}
		draw();
	}

	// ---------------------------------------------------------------------- import from a list
	//
	// A teacher's list is a JSON array: [{file, note, lang?}, ...]. plan.html collects the pages of
	// the list one by one and writes the outcome of each on the page. Only pages of this site are
	// fetched (js/layout.js knows them); a page that is not in the menu is skipped, a repeated page
	// keeps its first entry, and a note longer than 600 characters is shortened. The job is kept in
	// this browser after every page, so a network error, a pause or a reload goes on from the last
	// page done instead of starting over. Re-importing the same list shows the same rows again.
	function buildImport(){
		var STORE = 'dsv-plan-imports', LAST = 'dsv-plan-import-last', MAX_JOBS = 5;
		var NOTE_MAX = 600, MAX_ITEMS = 80;
		var LANGS = PLAN.CODE_LANGS || ['dugum', 'turkce', 'cpp', 'java'];
		var STATUS_KEYS = {normal: 'ppImportNormal', skipped: 'ppImportSkipped', duplicate: 'ppImportDuplicate', truncated: 'ppImportTruncated'};
		var current = null, running = false, token = 0;

		// ---- the job store
		function readJobs(){
			try {
				var all = JSON.parse(localStorage.getItem(STORE) || '{}');
				return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
			} catch(e) { return {}; }
		}
		function writeJobs(jobs){ try { localStorage.setItem(STORE, JSON.stringify(jobs)); } catch(e) {} }
		function persist(){
			if(!current) return;
			var jobs = readJobs();
			jobs[current.key] = current;
			var keys = Object.keys(jobs);
			if(keys.length > MAX_JOBS){
				keys.filter(function(k){ return k !== current.key; }).slice(0, keys.length - MAX_JOBS).forEach(function(k){ delete jobs[k]; });
			}
			writeJobs(jobs);
		}
		function lastKey(){
			try { var l = JSON.parse(localStorage.getItem(LAST) || 'null'); return l && l.key ? l.key : null; } catch(e) { return null; }
		}
		function setLast(key){ try { localStorage.setItem(LAST, JSON.stringify({key: key})); } catch(e) {} }
		function hash(text){
			var h = 5381;
			for(var i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
			return h.toString(36);
		}
		function keyOf(source){ return source.kind === 'url' ? 'u:' + source.url : 'f:' + hash(source.text); }

		// ---- reading the list
		function parseManifest(text){
			var data;
			try { data = JSON.parse(text); } catch(e) { return {error: 'json'}; }
			if(!(data instanceof Array)) return {error: 'array'};
			if(!data.length) return {error: 'empty'};
			return {items: data};
		}
		// the outcome of every item, decided in the order of the list (nothing is fetched here)
		function evaluate(items){
			var seen = {}, out = [];
			items.slice(0, MAX_ITEMS).forEach(function(raw){
				var isObject = raw && typeof raw === 'object' && !(raw instanceof Array);
				var file = isObject && typeof raw.file === 'string' ? raw.file : '';
				var note = isObject && typeof raw.note === 'string' ? raw.note : '';
				var lang = isObject && typeof raw.lang === 'string' && LANGS.indexOf(raw.lang) >= 0 ? raw.lang : '';
				var status;
				if(!file || !PLAN.known[file])
					status = 'skipped';
				else if(seen[file])
					status = 'duplicate';
				else {
					seen[file] = 1;
					if(note.length > NOTE_MAX){ note = note.slice(0, NOTE_MAX); status = 'truncated'; }
					else status = 'normal';
				}
				out.push({file: file, note: note, lang: lang, status: status, fetched: false});
			});
			return out;
		}
		function sameSiteUrl(value){
			var u;
			try { u = new URL(value, location.href); } catch(e) { return null; }
			if(u.origin !== location.origin || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
			u.hash = '';
			return u;
		}

		// ---- drawing
		var box = el('section', {'class': 'tp-box pp-import', id: 'pp-import'});
		box.appendChild(el('h2', {}, t('ppImportTitle')));
		box.appendChild(el('p', {'class': 'tp-help', id: 'pp-import-help'}, t('ppImportHelp')));

		var fieldUrl = el('label', {'class': 'tp-field pp-import-url'});
		fieldUrl.appendChild(el('span', {}, t('ppImportUrl')));
		var urlInput = el('input', {type: 'text', id: 'pp-import-url', placeholder: t('ppImportUrlPh'), 'aria-label': t('ppImportUrl'), autocomplete: 'off'});
		fieldUrl.appendChild(urlInput);
		box.appendChild(fieldUrl);

		var fieldFile = el('label', {'class': 'tp-field pp-import-file'});
		fieldFile.appendChild(el('span', {}, t('ppImportFile')));
		var fileInput = el('input', {type: 'file', id: 'pp-import-file', accept: '.json,application/json'});
		fieldFile.appendChild(fileInput);
		box.appendChild(fieldFile);

		var buttons = el('div', {'class': 'pp-actions'});
		var startBtn = el('button', {type: 'button', 'class': 'tp-btn primary', id: 'pp-import-start'}, t('ppImportStart'));
		var pauseBtn = el('button', {type: 'button', 'class': 'tp-btn', id: 'pp-import-pause'}, t('ppImportPause'));
		var resumeBtn = el('button', {type: 'button', 'class': 'tp-btn', id: 'pp-import-resume'}, t('ppImportResume'));
		pauseBtn.hidden = true;
		resumeBtn.hidden = true;
		buttons.appendChild(startBtn);
		buttons.appendChild(pauseBtn);
		buttons.appendChild(resumeBtn);
		box.appendChild(buttons);

		var errorBox = el('p', {'class': 'tp-warn', id: 'pp-import-error', role: 'alert'});
		errorBox.hidden = true;
		box.appendChild(errorBox);
		var statusText = el('p', {'class': 'pp-meta', id: 'pp-import-status', role: 'status', 'aria-live': 'polite'});
		box.appendChild(statusText);
		var counts = el('p', {'class': 'pp-meta pp-import-counts', id: 'pp-import-counts'});
		box.appendChild(counts);
		var rows = el('ol', {'class': 'pp-import-rows', id: 'pp-import-rows'}); // the status line already speaks for a screen reader
		box.appendChild(rows);
		var summary = el('p', {'class': 'pp-import-summary', id: 'pp-import-summary'});
		summary.hidden = true;
		box.appendChild(summary);
		var planRow = el('div', {'class': 'pp-actions pp-import-plan'});
		var openPlan = el('a', {'class': 'tp-btn primary', id: 'pp-import-open', href: '#'}, t('ppImportOpen'));
		openPlan.style.textDecoration = 'none';
		openPlan.hidden = true;
		var copyPlan = el('button', {type: 'button', 'class': 'tp-btn', id: 'pp-import-copy'}, t('ppImportCopy'));
		copyPlan.hidden = true;
		planRow.appendChild(openPlan);
		planRow.appendChild(copyPlan);
		box.appendChild(planRow);
		root.appendChild(box);

		function showError(text){
			errorBox.textContent = text || '';
			errorBox.hidden = !text;
		}
		function statusKeyOf(e){ return STATUS_KEYS[e.status]; }
		function whyOf(e){
			if(e.status === 'skipped') return t('ppImportWhySkipped');
			if(e.status === 'duplicate') return t('ppImportWhyDuplicate');
			if(e.status === 'truncated') return t('ppImportWhyTruncated');
			return '';
		}
		function rowEl(e){
			var li = el('li', {'class': 'pp-import-row', 'data-status': e.status, 'data-file': e.file});
			li.appendChild(el('span', {'class': 'pp-imp-file'}, e.file));
			li.appendChild(el('span', {'class': 'pp-imp-title'}, e.status === 'skipped' ? '' : titleOf(e.file)));
			var why = whyOf(e);
			var badge = el('span', {'class': 'pp-imp-status', 'data-status': e.status}, t(statusKeyOf(e)));
			if(why) badge.title = why;
			li.appendChild(badge);
			return li;
		}
		function countsOf(job){
			var c = {normal: 0, skipped: 0, duplicate: 0, truncated: 0};
			job.entries.slice(0, job.next).forEach(function(e){ if(c[e.status] !== undefined) c[e.status]++; });
			return c;
		}
		function planOf(job){
			var items = job.entries.filter(function(e){ return e.status === 'normal' || e.status === 'truncated'; })
			                         .map(function(e){ return {file: e.file, note: e.note, c: e.lang}; });
			return {t: t('ppImportPlan'), d: '', items: items, c: '', m: 0};
		}
		// where the imported plan starts (its first page, the plan bar around it) and the link for the students
		function planLinks(job){
			var plan = planOf(job);
			if(!plan.items.length) return {start: '', share: ''};
			var str = PLAN.encode(plan);
			return {start: PLAN.url(plan.items[0].file, str, 0, plan), share: 'plan.html#plan=' + str};
		}
		function paint(){
			if(current){
				var c = countsOf(current);
				counts.textContent = t('ppImportCounts', c);
				counts.setAttribute('data-normal', String(c.normal));
				counts.setAttribute('data-skipped', String(c.skipped));
				counts.setAttribute('data-duplicate', String(c.duplicate));
				counts.setAttribute('data-truncated', String(c.truncated));
				rows.textContent = '';
				current.entries.slice(0, current.next).forEach(function(e){ rows.appendChild(rowEl(e)); });
			}
			else {
				counts.textContent = '';
				rows.textContent = '';
			}
			var incomplete = !!current && !current.complete;
			pauseBtn.hidden = !running;
			resumeBtn.hidden = !(incomplete && !running);
			startBtn.disabled = running;
			if(running)
				statusText.textContent = t('ppImportRunning', {done: current.next, n: current.entries.length});
			else if(incomplete){
				statusText.textContent = current.error === 'network'
					? t('ppImportNetwork', {file: current.entries[current.next] ? current.entries[current.next].file : ''})
					: t('ppImportPaused', {done: current.next, n: current.entries.length});
			}
			else if(current)
				statusText.textContent = t('ppImportDone');
			else
				statusText.textContent = '';
			if(current && current.complete){
				var c2 = countsOf(current);
				summary.textContent = t('ppImportSummary', {n: current.next, normal: c2.normal, skipped: c2.skipped, duplicate: c2.duplicate, truncated: c2.truncated});
				summary.hidden = false;
				var links = planLinks(current);
				openPlan.href = links.start || '#';
				openPlan.hidden = !links.start;
				copyPlan.hidden = !links.share;
			}
			else {
				summary.hidden = true;
				openPlan.hidden = true;
				copyPlan.hidden = true;
			}
		}

		// ---- collecting the pages
		function fetchPage(file){
			return fetch(file, {cache: 'no-store', credentials: 'same-origin'}).then(function(res){
				if(!res.ok) throw new Error('HTTP ' + res.status);
				return res.text();
			});
		}
		function finish(){
			running = false;
			if(!current) return;
			current.complete = true;
			current.paused = false;
			current.running = false;
			current.error = '';
			persist();
			paint();
		}
		function run(){
			if(!current || current.complete) return;
			var job = current, my = ++token;
			running = true;
			job.paused = false;
			job.error = '';
			persist();
			paint();
			(function step(){
				if(my !== token || !running) return;
				if(job.next >= job.entries.length){ finish(); return; }
				var e = job.entries[job.next];
				if(e.status === 'skipped' || e.status === 'duplicate'){ // no page to fetch: the outcome is known at once
					job.next++;
					persist();
					paint();
					setTimeout(step, 0);
					return;
				}
				job.running = true; // a reload during this fetch goes on from this page
				persist();
				fetchPage(e.file).then(function(){
					if(my !== token || !running) return;
					e.fetched = true;
					job.next++;
					job.running = false;
					persist();
					paint();
					setTimeout(step, 0);
				}, function(){
					if(my !== token) return;
					job.running = false;
					// a break, not a pause by the user: a reload goes on from this page by itself
					job.paused = false;
					job.error = 'network';
					running = false;
					persist();
					paint();
				});
			})();
		}
		function pause(){
			if(!current) return;
			running = false;
			token++;
			current.paused = true;
			current.running = false;
			persist();
			paint();
		}
		function begin(source, text){
			var parsed = parseManifest(text);
			if(parsed.error){ showError(t('ppImportErr' + parsed.error.charAt(0).toUpperCase() + parsed.error.slice(1))); return; }
			var key = keyOf(source), sig = hash(text); // the whole list is not kept, only its fingerprint
			var jobs = readJobs();
			var job = jobs[key];
			if(!job || job.sig !== sig || !(job.entries instanceof Array)){ // a new list, or the same address with other contents
				job = {key: key, kind: source.kind, name: source.name || source.url || '', sig: sig, entries: evaluate(parsed.items),
				       next: 0, running: false, paused: false, complete: false, error: ''};
				jobs[key] = job;
				writeJobs(jobs);
			}
			else if(job.error === 'network'){ // the same list again: a break before does not need another try by hand
				job.error = '';
				job.paused = false;
			}
			setLast(key);
			current = job;
			running = false;
			token++;
			showError('');
			persist();
			run();
		}

		// ---- events
		startBtn.addEventListener('click', function(){
			var value = urlInput.value.trim();
			if(value){
				var u = sameSiteUrl(value);
				if(!u){ showError(t('ppImportErrUrl')); return; }
				showError('');
				startBtn.disabled = true;
				fetch(u.href, {cache: 'no-store', credentials: 'same-origin'}).then(function(res){
					if(!res.ok) throw new Error('HTTP ' + res.status);
					return res.text();
				}).then(function(text){
					begin({kind: 'url', url: u.href, name: u.href}, text);
				}, function(){
					showError(t('ppImportErrFetch'));
				}).then(function(){ startBtn.disabled = running; paint(); });
				return;
			}
			var file = fileInput.files && fileInput.files[0];
			if(!file){ showError(t('ppImportErrNone')); return; }
			var reader = new FileReader();
			reader.onload = function(){ begin({kind: 'file', text: String(reader.result || ''), name: file.name}, String(reader.result || '')); };
			reader.onerror = function(){ showError(t('ppImportErrFile')); };
			reader.readAsText(file);
		});
		pauseBtn.addEventListener('click', pause);
		resumeBtn.addEventListener('click', function(){ if(current){ showError(''); run(); } });
		copyPlan.addEventListener('click', function(){
			var links = planLinks(current);
			if(links.share) copy(new URL(links.share, location.href).href, t('ppImportCopied'));
		});
		urlInput.addEventListener('input', function(){ showError(''); });

		// ---- after a reload: the last list is drawn again and, if it was interrupted, goes on
		var jobs = readJobs(), last = lastKey();
		if(last && jobs[last] && jobs[last].entries instanceof Array){
			current = jobs[last];
			paint();
			if(!current.complete && !current.paused) // interrupted (a page refresh), not paused by the user
				run();
		}
		else
			paint();

		window.dsvPlanImport = {job: function(){ return current ? JSON.parse(JSON.stringify(current)) : null; }, run: run, pause: pause}; // for the tests
	}

	// ---------------------------------------------------------------------- the student's plan page
	function buildPlan(){
		var found = PLAN.fromHash(location.hash);
		var h1 = document.querySelector('main.lesson h1');
		if(!found){
			if(h1) h1.textContent = t('ppEmptyTitle');
			root.appendChild(el('p', {'class': 'pp-intro', id: 'pp-empty'}, t('ppEmpty')));
			var make = el('a', {'class': 'tp-btn primary', href: 'teacher.html'}, t('teacherLink'));
			make.style.textDecoration = 'none';
			root.appendChild(make);
			buildImport();
			return;
		}
		var plan = found.plan, str = found.str, id = found.id, doneMap = PLAN.done(id), n = plan.items.length;
		if(h1) h1.textContent = plan.t || t('planBarLabel');
		document.title = (plan.t || t('planBarLabel')) + ' | ' + t('brand');

		var head = el('div', {'class': 'pp-head'});
		if(plan.d) head.appendChild(el('p', {'class': 'pp-intro', id: 'pp-intro'}, plan.d));
		var meta = [];
		if(plan.c) meta.push(t('ppCodeNote', {lang: CODE_NAMES[plan.c]}));
		if(plan.m) meta.push(t('ppLessonNote'));
		meta.push(t('ppRunNote'));
		meta.forEach(function(m){ head.appendChild(el('p', {'class': 'pp-meta'}, m)); });
		if(plan.dropped)
			head.appendChild(el('p', {'class': 'pp-meta tp-warn'}, t('ppDropped', {n: plan.dropped})));
		root.appendChild(head);

		classBox(found);

		var doneCount = plan.items.filter(function(x){ return doneMap[x.file]; }).length;
		var bar = el('div', {'class': 'pp-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(n), 'aria-valuenow': String(doneCount)});
		var fill = el('div', {});
		fill.style.width = (n ? Math.round(100 * doneCount / n) : 0) + '%';
		bar.appendChild(fill);
		root.appendChild(el('p', {'class': 'pp-meta', id: 'pp-progress'}, doneCount === n && n ? t('ppAllDone') : t('ppProgress', {done: doneCount, n: n})));
		root.appendChild(bar);

		var ol = el('ol', {'class': 'pp-list'});
		var firstTodo = -1;
		plan.items.forEach(function(x, k){
			var isDone = !!doneMap[x.file];
			if(!isDone && firstTodo < 0) firstTodo = k;
			var li = el('li', {'class': 'pp-item' + (isDone ? ' done' : ''), 'data-file': x.file});
			li.appendChild(el('span', {'class': 'pp-no', 'aria-label': isDone ? t('ppDone') : ''}, isDone ? '✓' : String(k + 1)));
			var body = el('div', {'class': 'pp-body'});
			body.appendChild(el('a', {href: PLAN.url(x.file, str, k, plan)}, titleOf(x.file)));
			body.appendChild(el('span', {'class': 'pp-group'}, groupOf(x.file)));
			if(x.note) body.appendChild(el('p', {'class': 'pp-note'}, x.note));
			li.appendChild(body);
			ol.appendChild(li);
		});
		root.appendChild(ol);

		var actions = el('div', {'class': 'pp-actions'});
		if(n){
			var go = firstTodo >= 0 ? firstTodo : 0;
			var start = el('a', {'class': 'tp-btn primary', id: 'pp-start', href: PLAN.url(plan.items[go].file, str, go, plan)}, doneCount ? t('ppContinue') : t('ppStart'));
			start.style.textDecoration = 'none';
			actions.appendChild(start);
		}
		var edit = el('a', {'class': 'tp-btn', id: 'pp-edit', href: 'teacher.html#plan=' + str}, t('ppEdit'));
		edit.style.textDecoration = 'none';
		actions.appendChild(edit);
		var share = el('button', {type: 'button', 'class': 'tp-btn', id: 'pp-share'}, t('ppShare'));
		share.addEventListener('click', function(){ copy(location.href, t('tpCopied')); });
		actions.appendChild(share);
		root.appendChild(actions);
		buildImport();
	}

	if(kind === 'teacher') buildTeacher();
	else if(kind === 'plan'){
		buildPlan();
		window.addEventListener('hashchange', function(){ location.reload(); }); // another plan or class link pasted into the same tab
	}
})();

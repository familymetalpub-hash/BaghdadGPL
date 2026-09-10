(() => {
    "use strict";

    /*
     * The original repository contains a static workshop page and no API or
     * database schema.  This small store keeps the existing page usable while
     * giving the management screens one consistent data source.  If an API is
     * added later, only loadState/saveState need to be replaced; the views keep
     * using customerId and operationId rather than copying customer data.
     */
    const STORAGE_KEY = "baghdad-gpl-workshop-v1";
    const TODAY = new Date().toISOString().slice(0, 10);
    const DOCUMENT_TYPES = [
        { key: "montage", label: "Certificat Montage", icon: "fa-file-signature", hint: "Fiche liée à l'opération" },
        { key: "visite", label: "Certificat Visite", icon: "fa-clipboard-check", hint: "Fiche liée à l'opération" },
        { key: "epreuve", label: "Certificat Épreuve", icon: "fa-file-circle-check", hint: "Fiche liée à l'opération" },
        { key: "etancheite", label: "Certificat Étanchéité", icon: "fa-droplet", hint: "Fiche liée à l'opération" },
        { key: "carte", label: "Carte GPL", icon: "fa-id-card", hint: "Carte liée à l'opération" }
    ];
    const OPERATION_TYPES = ["Installation", "Réparation", "Visite", "Épreuve", "Étanchéité", "Vente"];
    const CONTACTS = [
        { name: "Chlef", phone: "213557985364", label: "0557 98 53 64", map: "https://maps.app.goo.gl/QpTY7QFyVcwsT8169" },
        { name: "Oran", phone: "213550141155", label: "0550 14 11 55", map: "https://maps.app.goo.gl/6fL25SSXCcastyTk8" },
        { name: "Boumerdès", phone: "213561950760", label: "0561 95 07 60", map: "https://maps.app.goo.gl/emjmatB9XgC5V1T98" }
    ];
    const SOCIALS = [
        { name: "Facebook Chlef", icon: "fa-facebook", url: "https://www.facebook.com/meghitbaghdad02" },
        { name: "Facebook Oran", icon: "fa-facebook", url: "https://www.facebook.com/baghdadmeghitmohammed" },
        { name: "Facebook Boumerdès", icon: "fa-facebook", url: "https://www.facebook.com/profile.php?id=61556587512621" },
        { name: "TikTok", icon: "fa-tiktok", url: "https://www.tiktok.com/@family.mtl.gpl?is_from_webapp=1&sender_device=pc" }
    ];

    let state = loadState();
    let currentCustomerFilter = "";
    let currentOperationFilter = "";

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const mainContent = $("#mainContent");
    const modalRoot = $("#modalRoot");
    const logoFileInput = $("#logoFileInput");

    function createDefaultState() {
        return {
            version: 1,
            settings: {
                name: "BAGHDAD GPL - FAMILY METAL",
                phone: "0557 98 53 64",
                address: "",
                email: "familymetal_1@hotmail.com",
                website: "www.familymetaldz.com",
                logo: "img/logo.png"
            },
            customers: [],
            operations: [],
            products: [],
            notifications: []
        };
    }

    function loadState() {
        const fallback = createDefaultState();
        try {
            const stored = window.localStorage.getItem(STORAGE_KEY);
            if (!stored) return fallback;
            const parsed = JSON.parse(stored);
            const loaded = {
                ...fallback,
                ...parsed,
                settings: { ...fallback.settings, ...(parsed.settings || {}) },
                customers: Array.isArray(parsed.customers) ? parsed.customers : [],
                operations: Array.isArray(parsed.operations) ? parsed.operations : [],
                products: Array.isArray(parsed.products) ? parsed.products : [],
                notifications: Array.isArray(parsed.notifications) ? parsed.notifications : []
            };
            // Keep existing records valid when an older data set did not have address.
            loaded.customers = loaded.customers.map((customer) => ({ ...customer, address: customer.address || "" }));
            loaded.operations = loaded.operations.map((operation) => ({
                ...operation,
                customerId: operation.customerId || operation.clientId || "",
                quantity: numberOr(operation.quantity, 1),
                unitPrice: numberOr(operation.unitPrice, operation.price || 0),
                date: operation.date || TODAY
            }));
            return loaded;
        } catch (error) {
            console.warn("Impossible de lire les données locales de l'atelier.", error);
            return fallback;
        }
    }

    function saveState() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (error) {
            console.warn("Impossible d'enregistrer les données locales de l'atelier.", error);
            showToast("Les données n'ont pas pu être enregistrées sur cet appareil.", true);
        }
    }

    function numberOr(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function uid(prefix) {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return `${prefix}-${window.crypto.randomUUID()}`;
        }
        return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function escapeHTML(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function escapeAttr(value) {
        return escapeHTML(value);
    }

    function fullName(customer) {
        if (!customer) return "Client introuvable";
        return [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim() || "Client sans nom";
    }

    function initials(value) {
        const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
        return (parts.slice(0, 2).map((part) => part[0]).join("") || "CL").toUpperCase();
    }

    function getCustomer(id) {
        return state.customers.find((customer) => customer.id === id);
    }

    function getOperation(id) {
        return state.operations.find((operation) => operation.id === id);
    }

    function getProduct(id) {
        return state.products.find((product) => product.id === id);
    }

    function operationCustomer(operation) {
        return getCustomer(operation && operation.customerId);
    }

    function formatMoney(value) {
        const amount = numberOr(value, 0);
        return `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)} DA`;
    }

    function formatDate(value) {
        if (!value) return "—";
        const date = new Date(`${value}T00:00:00`);
        if (Number.isNaN(date.getTime())) return escapeHTML(value);
        return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
    }

    function externalHref(value) {
        const raw = String(value || "").trim();
        if (!raw) return "#";
        return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    }

    function nowLabel() {
        return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date());
    }

    function operationTotal(operation) {
        if (Array.isArray(operation.items) && operation.items.length) {
            return operation.items.reduce((sum, item) => sum + numberOr(item.unitPrice, 0) * Math.max(numberOr(item.quantity, 1), 0), 0);
        }
        if (typeof operation.total === "number") return operation.total;
        return numberOr(operation.unitPrice, 0) * Math.max(numberOr(operation.quantity, 1), 0);
    }

    function operationDesignation(operation) {
        const product = getProduct(operation && operation.productId);
        return operation && (operation.designation || (product && product.name) || operation.type) || "Opération";
    }

    function operationTypeIcon(type) {
        const icons = {
            "Installation": "fa-wrench",
            "Réparation": "fa-screwdriver-wrench",
            "Visite": "fa-clipboard-check",
            "Épreuve": "fa-file-circle-check",
            "Étanchéité": "fa-droplet",
            "Vente": "fa-cart-shopping"
        };
        return icons[type] || "fa-list-check";
    }

    function operationBadge(type) {
        const tone = type === "Réparation" || type === "Installation" ? "teal" : type === "Vente" ? "orange" : "";
        return `<span class="badge ${tone}">${escapeHTML(type || "Opération")}</span>`;
    }

    function getRoute() {
        const raw = window.location.hash.replace(/^#/, "") || "home";
        const parts = raw.split("/").map((part) => decodeURIComponent(part));
        if (parts[0] === "operation" && parts[1]) return { view: "operation", id: parts[1] };
        if (parts[0] === "document" && parts[1] && parts[2]) return { view: "document", id: parts[1], documentType: parts[2] };
        if (parts[0] === "invoice" && parts[1]) return { view: "invoice", id: parts[1] };
        if (parts[0] === "client" && parts[1]) return { view: "client", id: parts[1] };
        return { view: ["home", "clients", "operations", "settings"].includes(parts[0]) ? parts[0] : "home" };
    }

    function navigate(hash) {
        const next = hash.startsWith("#") ? hash : `#${hash}`;
        if (window.location.hash === next) {
            render();
        } else {
            window.location.hash = next;
        }
    }

    function setBreadcrumb(route) {
        const breadcrumb = $("#breadcrumb");
        if (!breadcrumb) return;
        const labels = {
            home: "Accueil",
            clients: "Clients & Opérations",
            operations: "Opérations",
            settings: "Paramètres",
            operation: "Détail de l'opération",
            document: "Document",
            invoice: "Facture",
            client: "Fiche client"
        };
        let current = labels[route.view] || "Accueil";
        if (route.view === "operation") {
            const operation = getOperation(route.id);
            current = operation ? `Opération · ${operationDesignation(operation)}` : current;
        }
        if (route.view === "document") {
            const document = DOCUMENT_TYPES.find((item) => item.key === route.documentType);
            current = document ? document.label : current;
        }
        if (route.view === "invoice") {
            const customer = getCustomer(route.id);
            current = customer ? `Facture · ${fullName(customer)}` : current;
        }
        breadcrumb.innerHTML = `<span>Family Metal</span><span class="crumb-separator">/</span><strong>${escapeHTML(current)}</strong>`;
    }

    function updateActiveNavigation(view) {
        $$(".nav-link[data-view]").forEach((link) => link.classList.toggle("active", link.dataset.view === view));
    }

    function render() {
        const route = getRoute();
        setBreadcrumb(route);
        updateActiveNavigation(route.view === "operation" || route.view === "document" || route.view === "invoice" || route.view === "client" ? "clients" : route.view);
        updateNotificationUI();
        switch (route.view) {
            case "clients":
                mainContent.innerHTML = renderClientsView();
                break;
            case "operations":
                mainContent.innerHTML = renderOperationsView();
                break;
            case "settings":
                mainContent.innerHTML = renderSettingsView();
                break;
            case "operation":
                mainContent.innerHTML = renderOperationDetail(route.id);
                break;
            case "document":
                mainContent.innerHTML = renderDocumentView(route.id, route.documentType);
                break;
            case "invoice":
                mainContent.innerHTML = renderInvoiceView(route.id);
                break;
            case "client":
                mainContent.innerHTML = renderCustomerView(route.id);
                break;
            default:
                mainContent.innerHTML = renderHomeView();
        }
        if (route.view === "clients") renderClientsTable(currentCustomerFilter);
        if (route.view === "operations") renderOperationsTable(currentOperationFilter);
        mainContent.focus({ preventScroll: true });
    }

    function renderHomeView() {
        const operationCount = state.operations.length;
        const total = state.operations.reduce((sum, operation) => sum + operationTotal(operation), 0);
        const settings = state.settings;
        const contactRows = CONTACTS.map((contact) => `
            <div class="contact-row">
                <span class="contact-icon"><i class="fa-brands fa-whatsapp" aria-hidden="true"></i></span>
                <div><strong>${escapeHTML(contact.name)}</strong><a href="https://wa.me/${escapeAttr(contact.phone)}" target="_blank" rel="noopener">WhatsApp · ${escapeHTML(contact.label)}</a></div>
            </div>
        `).join("");
        const socialRows = SOCIALS.map((social) => `
            <div class="contact-row">
                <span class="contact-icon"><i class="fa-brands ${escapeAttr(social.icon)}" aria-hidden="true"></i></span>
                <div><strong>${escapeHTML(social.name)}</strong><a href="${escapeAttr(social.url)}" target="_blank" rel="noopener">Ouvrir le profil</a></div>
            </div>
        `).join("");
        return `
            <section class="welcome-card">
                <div class="welcome-copy">
                    <p class="eyebrow">Gestion de l'atelier</p>
                    <h1>Bienvenue dans votre espace Family Metal.</h1>
                    <p>Suivez vos clients, vos opérations et vos documents depuis un espace simple. Les informations affichées dans les documents et les factures proviennent des fiches enregistrées.</p>
                    <div class="welcome-actions">
                        <a class="btn btn-primary" href="#clients"><i class="fa-solid fa-users" aria-hidden="true"></i>Voir les clients</a>
                        <button class="btn btn-secondary" type="button" data-action="open-new-operation"><i class="fa-solid fa-plus" aria-hidden="true"></i>Nouvelle opération</button>
                    </div>
                </div>
            </section>
            <div class="stats-grid">
                <div class="card stat-card"><span class="stat-icon"><i class="fa-solid fa-users" aria-hidden="true"></i></span><div><div class="stat-label">Clients enregistrés</div><div class="stat-value">${state.customers.length}</div></div></div>
                <div class="card stat-card"><span class="stat-icon blue"><i class="fa-solid fa-list-check" aria-hidden="true"></i></span><div><div class="stat-label">Opérations</div><div class="stat-value">${operationCount}</div></div></div>
                <div class="card stat-card"><span class="stat-icon orange"><i class="fa-solid fa-coins" aria-hidden="true"></i></span><div><div class="stat-label">Total des opérations</div><div class="stat-value">${formatMoney(total)}</div></div></div>
                <div class="card stat-card"><span class="stat-icon purple"><i class="fa-solid fa-file-invoice" aria-hidden="true"></i></span><div><div class="stat-label">Documents disponibles</div><div class="stat-value">${operationCount * DOCUMENT_TYPES.length}</div></div></div>
            </div>
            <div class="home-grid">
                <section class="card">
                    <div class="card-header"><div><h2>Accès rapides</h2><p>Les fonctions les plus utilisées de l'atelier.</p></div></div>
                    <div class="card-body quick-links">
                        <a class="quick-link" href="#clients"><span class="quick-icon"><i class="fa-solid fa-user-plus" aria-hidden="true"></i></span><div><strong>Ajouter un client</strong><span>Créer une fiche complète</span></div></a>
                        <button class="quick-link" type="button" data-action="open-new-operation"><span class="quick-icon"><i class="fa-solid fa-square-plus" aria-hidden="true"></i></span><div><strong>Nouvelle opération</strong><span>Réparation, visite, vente…</span></div></button>
                        <a class="quick-link" href="#settings"><span class="quick-icon"><i class="fa-solid fa-gear" aria-hidden="true"></i></span><div><strong>Paramètres</strong><span>Logo et coordonnées atelier</span></div></a>
                        <a class="quick-link" href="#operations"><span class="quick-icon"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i></span><div><strong>Historique</strong><span>Consulter les opérations</span></div></a>
                    </div>
                </section>
                <section class="card">
                    <div class="card-header"><div><h2>Coordonnées de l'atelier</h2><p>Informations de contact existantes.</p></div></div>
                    <div class="card-body home-contact">
                        <div class="contact-row"><span class="contact-icon"><i class="fa-solid fa-phone" aria-hidden="true"></i></span><div><strong>${escapeHTML(settings.name)}</strong><span>${escapeHTML(settings.phone || "Téléphone non renseigné")}</span></div></div>
                        ${settings.address ? `<div class="contact-row"><span class="contact-icon"><i class="fa-solid fa-location-dot" aria-hidden="true"></i></span><div><strong>Adresse</strong><span>${escapeHTML(settings.address)}</span></div></div>` : ""}
                        ${settings.email ? `<div class="contact-row"><span class="contact-icon"><i class="fa-solid fa-envelope" aria-hidden="true"></i></span><div><strong>Email</strong><a href="mailto:${escapeAttr(settings.email)}">${escapeHTML(settings.email)}</a></div></div>` : ""}
                        ${settings.website ? `<div class="contact-row"><span class="contact-icon"><i class="fa-solid fa-globe" aria-hidden="true"></i></span><div><strong>Website</strong><a href="${escapeAttr(externalHref(settings.website))}" target="_blank" rel="noopener">${escapeHTML(settings.website)}</a></div></div>` : ""}
                        ${contactRows}
                        ${socialRows}
                    </div>
                </section>
            </div>
        `;
    }

    function renderStats() {
        const total = state.operations.reduce((sum, operation) => sum + operationTotal(operation), 0);
        return `
            <div class="stats-grid">
                <div class="card stat-card"><span class="stat-icon"><i class="fa-solid fa-users" aria-hidden="true"></i></span><div><div class="stat-label">Clients</div><div class="stat-value">${state.customers.length}</div></div></div>
                <div class="card stat-card"><span class="stat-icon blue"><i class="fa-solid fa-list-check" aria-hidden="true"></i></span><div><div class="stat-label">Opérations</div><div class="stat-value">${state.operations.length}</div></div></div>
                <div class="card stat-card"><span class="stat-icon orange"><i class="fa-solid fa-coins" aria-hidden="true"></i></span><div><div class="stat-label">Montant cumulé</div><div class="stat-value">${formatMoney(total)}</div></div></div>
                <div class="card stat-card"><span class="stat-icon purple"><i class="fa-solid fa-boxes-stacked" aria-hidden="true"></i></span><div><div class="stat-label">Produits catalogue</div><div class="stat-value">${state.products.length}</div></div></div>
            </div>
        `;
    }

    function renderClientsView() {
        return `
            <div class="page-heading">
                <div><p class="eyebrow">Suivi commercial</p><h1>Clients &amp; Opérations</h1><p>Retrouvez les fiches clients, leur adresse et l'historique réel des opérations réalisées.</p></div>
                <div class="heading-actions"><button class="btn btn-secondary" type="button" data-action="open-new-operation"><i class="fa-solid fa-plus" aria-hidden="true"></i>Nouvelle opération</button><button class="btn btn-primary" type="button" data-action="open-new-customer"><i class="fa-solid fa-user-plus" aria-hidden="true"></i>Nouveau client</button></div>
            </div>
            ${renderStats()}
            <section class="card table-card">
                <div class="table-toolbar"><div class="toolbar-left"><div><strong style="font-size:13px;">Liste des clients</strong><div style="color:var(--muted);font-size:10px;margin-top:3px;">${state.customers.length} fiche${state.customers.length > 1 ? "s" : ""} enregistrée${state.customers.length > 1 ? "s" : ""}</div></div></div><div class="toolbar-right"><label class="search-box"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-customer-filter value="${escapeAttr(currentCustomerFilter)}" placeholder="Rechercher un client…" aria-label="Rechercher un client"></label></div></div>
                <div class="table-wrap"><table><thead><tr><th>Client</th><th>Téléphone</th><th>Adresse</th><th>Opérations</th><th>Total</th><th class="actions-cell">Actions</th></tr></thead><tbody id="clientsTableBody"></tbody></table></div>
            </section>
            <div style="height:20px"></div>
            <section class="card table-card">
                <div class="card-header"><div><h2>Dernières opérations</h2><p>Chaque fiche reste liée à son client par son identifiant.</p></div><a class="btn btn-plain btn-small" href="#operations">Voir tout <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a></div>
                ${renderRecentOperations()}
            </section>
        `;
    }

    function renderClientsTable(filter = currentCustomerFilter) {
        const body = $("#clientsTableBody");
        if (!body) return;
        const normalized = String(filter || "").trim().toLocaleLowerCase("fr");
        const customers = state.customers.filter((customer) => {
            const haystack = `${fullName(customer)} ${customer.phone || ""} ${customer.address || ""} ${customer.email || ""}`.toLocaleLowerCase("fr");
            return !normalized || haystack.includes(normalized);
        });
        if (!customers.length) {
            body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><i class="fa-solid fa-user-group" aria-hidden="true"></i><strong>${state.customers.length ? "Aucun résultat" : "Aucun client enregistré"}</strong><p>${state.customers.length ? "Essayez avec un autre nom, téléphone ou adresse." : "Créez une fiche client pour commencer à enregistrer les opérations de l'atelier."}</p>${state.customers.length ? "" : `<button class="btn btn-primary btn-small" type="button" data-action="open-new-customer"><i class="fa-solid fa-user-plus" aria-hidden="true"></i>Ajouter un client</button>`}</div></td></tr>`;
            return;
        }
        body.innerHTML = customers.map((customer) => {
            const operations = state.operations.filter((operation) => operation.customerId === customer.id);
            const total = operations.reduce((sum, operation) => sum + operationTotal(operation), 0);
            return `<tr>
                <td><div class="client-cell"><span class="client-avatar">${escapeHTML(initials(fullName(customer)))}</span><div><div class="client-name">${escapeHTML(fullName(customer))}</div>${customer.email ? `<div class="client-email">${escapeHTML(customer.email)}</div>` : ""}</div></div></td>
                <td class="phone-cell">${customer.phone ? escapeHTML(customer.phone) : "—"}</td>
                <td class="address-cell" title="${escapeAttr(customer.address || "Adresse non renseignée")}">${customer.address ? escapeHTML(customer.address) : "—"}</td>
                <td><span class="badge">${operations.length}</span></td>
                <td class="total-cell">${formatMoney(total)}</td>
                <td class="actions-cell">
                    <button class="action-text" type="button" data-action="create-invoice" data-id="${escapeAttr(customer.id)}" title="Créer une facture"><i class="fa-solid fa-file-invoice" aria-hidden="true"></i>Créer une facture</button>
                    <button class="action-icon" type="button" data-action="view-customer" data-id="${escapeAttr(customer.id)}" title="Voir le client" aria-label="Voir le client"><i class="fa-solid fa-eye" aria-hidden="true"></i></button>
                    <button class="action-icon" type="button" data-action="edit-customer" data-id="${escapeAttr(customer.id)}" title="Modifier" aria-label="Modifier"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button>
                    <button class="action-icon danger" type="button" data-action="delete-customer" data-id="${escapeAttr(customer.id)}" title="Supprimer" aria-label="Supprimer"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
                </td>
            </tr>`;
        }).join("");
    }

    function renderRecentOperations() {
        const operations = [...state.operations].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
        if (!operations.length) {
            return `<div class="empty-state"><i class="fa-solid fa-clipboard-list" aria-hidden="true"></i><strong>Aucune opération enregistrée</strong><p>Ajoutez une opération depuis le bouton « Nouvelle opération ».</p></div>`;
        }
        return `<div class="operation-list">${operations.map((operation) => renderOperationRow(operation)).join("")}</div>`;
    }

    function renderOperationRow(operation) {
        const customer = operationCustomer(operation);
        return `<a class="operation-row" href="#operation/${encodeURIComponent(operation.id)}">
            <span class="operation-type-icon"><i class="fa-solid ${escapeAttr(operationTypeIcon(operation.type))}" aria-hidden="true"></i></span>
            <span class="operation-main"><strong>${escapeHTML(operationDesignation(operation))}</strong><span>${escapeHTML(customer ? fullName(customer) : "Client introuvable")} · ${escapeHTML(operation.type || "Opération")}</span></span>
            <span class="operation-side"><strong>${formatMoney(operationTotal(operation))}</strong><span>${formatDate(operation.date)}</span></span>
            <i class="fa-solid fa-chevron-right" aria-hidden="true" style="color:#b8c4c7;font-size:10px;"></i>
        </a>`;
    }

    function renderOperationsView() {
        return `
            <div class="page-heading"><div><p class="eyebrow">Journal de l'atelier</p><h1>Opérations</h1><p>Consultez chaque opération et ouvrez ses documents directement avec le client lié.</p></div><div class="heading-actions"><button class="btn btn-primary" type="button" data-action="open-new-operation"><i class="fa-solid fa-plus" aria-hidden="true"></i>Nouvelle opération</button></div></div>
            ${renderStats()}
            <section class="card table-card">
                <div class="table-toolbar"><div><strong style="font-size:13px;">Historique des opérations</strong><div style="color:var(--muted);font-size:10px;margin-top:3px;">${state.operations.length} opération${state.operations.length > 1 ? "s" : ""}</div></div><label class="search-box"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-operation-filter value="${escapeAttr(currentOperationFilter)}" placeholder="Rechercher…" aria-label="Rechercher une opération"></label></div>
                <div class="table-wrap"><table><thead><tr><th>Date</th><th>Client</th><th>Type</th><th>Désignation</th><th>Quantité</th><th>Total</th><th class="actions-cell">Actions</th></tr></thead><tbody id="operationsTableBody"></tbody></table></div>
            </section>
        `;
    }

    function renderOperationsTable(filter = currentOperationFilter) {
        const body = $("#operationsTableBody");
        if (!body) return;
        const normalized = String(filter || "").trim().toLocaleLowerCase("fr");
        const operations = [...state.operations]
            .sort((a, b) => String(b.date).localeCompare(String(a.date)))
            .filter((operation) => {
                const customer = operationCustomer(operation);
                const haystack = `${operationDesignation(operation)} ${operation.type || ""} ${customer ? fullName(customer) : ""} ${customer ? customer.phone || "" : ""}`.toLocaleLowerCase("fr");
                return !normalized || haystack.includes(normalized);
            });
        if (!operations.length) {
            body.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="fa-solid fa-clipboard-list" aria-hidden="true"></i><strong>${state.operations.length ? "Aucun résultat" : "Aucune opération enregistrée"}</strong><p>${state.operations.length ? "Essayez avec un autre terme." : "Créez une opération après avoir ajouté un client."}</p>${state.operations.length ? "" : `<button class="btn btn-primary btn-small" type="button" data-action="open-new-operation"><i class="fa-solid fa-plus" aria-hidden="true"></i>Nouvelle opération</button>`}</div></td></tr>`;
            return;
        }
        body.innerHTML = operations.map((operation) => {
            const customer = operationCustomer(operation);
            return `<tr>
                <td>${formatDate(operation.date)}</td>
                <td><div class="client-cell"><span class="client-avatar">${escapeHTML(initials(customer ? fullName(customer) : "CL"))}</span><div class="client-name">${escapeHTML(customer ? fullName(customer) : "Client introuvable")}</div></div></td>
                <td>${operationBadge(operation.type)}</td>
                <td>${escapeHTML(operationDesignation(operation))}</td>
                <td>${numberOr(operation.quantity, 1)}</td>
                <td class="total-cell">${formatMoney(operationTotal(operation))}</td>
                <td class="actions-cell"><button class="action-icon" type="button" data-action="view-operation" data-id="${escapeAttr(operation.id)}" title="Voir" aria-label="Voir"><i class="fa-solid fa-eye" aria-hidden="true"></i></button><button class="action-icon" type="button" data-action="open-documents" data-id="${escapeAttr(operation.id)}" title="Documents" aria-label="Documents"><i class="fa-solid fa-folder-open" aria-hidden="true"></i></button><button class="action-icon" type="button" data-action="edit-operation" data-id="${escapeAttr(operation.id)}" title="Modifier" aria-label="Modifier"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button></td>
            </tr>`;
        }).join("");
    }

    function renderOperationDetail(id) {
        const operation = getOperation(id);
        if (!operation) return renderNotFound("Opération introuvable", "Cette opération n'existe plus ou son identifiant est incorrect.", "#operations");
        const customer = operationCustomer(operation);
        const product = getProduct(operation.productId);
        return `
            <div class="detail-header"><div><a class="back-link" href="#operations"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>Retour aux opérations</a><div class="detail-title"><h1>${escapeHTML(operationDesignation(operation))}</h1>${operationBadge(operation.type)}</div><div class="detail-meta">Opération enregistrée le ${formatDate(operation.date)} · Référence ${escapeHTML(operation.id)}</div></div><div class="detail-actions"><button class="btn btn-secondary" type="button" data-action="edit-operation" data-id="${escapeAttr(operation.id)}"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>Modifier</button><button class="btn btn-danger" type="button" data-action="delete-operation" data-id="${escapeAttr(operation.id)}"><i class="fa-solid fa-trash-can" aria-hidden="true"></i>Supprimer</button></div></div>
            <div class="info-grid">
                <div class="card info-card"><div class="info-label"><i class="fa-solid fa-user" aria-hidden="true"></i>Client</div><div class="info-value">${customer ? escapeHTML(fullName(customer)) : "Client introuvable"}<small>${customer ? escapeHTML(customer.email || "") : ""}</small></div></div>
                <div class="card info-card"><div class="info-label"><i class="fa-solid fa-phone" aria-hidden="true"></i>Téléphone</div><div class="info-value">${customer && customer.phone ? escapeHTML(customer.phone) : "Non renseigné"}<small>Depuis la fiche client</small></div></div>
                <div class="card info-card"><div class="info-label"><i class="fa-solid fa-location-dot" aria-hidden="true"></i>Adresse</div><div class="info-value">${customer && customer.address ? escapeHTML(customer.address) : "Non renseignée"}<small>Depuis la fiche client</small></div></div>
                <div class="card info-card"><div class="info-label"><i class="fa-solid fa-coins" aria-hidden="true"></i>Total</div><div class="info-value">${formatMoney(operationTotal(operation))}<small>${numberOr(operation.quantity, 1)} × ${formatMoney(operation.unitPrice)}</small></div></div>
            </div>
            <section class="card" style="margin-bottom:20px;"><div class="card-header"><div><h2>Résumé de l'opération</h2><p>Les données sont liées par l'identifiant du client et de l'opération.</p></div></div><div class="card-body"><div class="form-grid"><div class="form-field"><label>Type d'opération</label><input value="${escapeAttr(operation.type || "")}" readonly></div><div class="form-field"><label>Produit</label><input value="${escapeAttr(product ? product.name : "Aucun produit associé")}" readonly></div><div class="form-field"><label>Désignation</label><input value="${escapeAttr(operationDesignation(operation))}" readonly></div><div class="form-field"><label>Quantité / Prix unitaire</label><input value="${escapeAttr(`${numberOr(operation.quantity, 1)} × ${formatMoney(operation.unitPrice)}`)}" readonly></div></div></div></section>
            <section><div class="card-header" style="padding-left:0;padding-right:0;border-bottom:0;"><div><h2>Actions</h2><p>Chaque action possède une icône distincte et ouvre la fonction correspondante.</p></div></div><div class="action-grid">
                <button class="action-tile" type="button" data-action="open-documents" data-id="${escapeAttr(operation.id)}"><span class="tile-icon"><i class="fa-solid fa-folder-open" aria-hidden="true"></i></span><span><strong>Documents</strong><span>Certificats et Carte GPL</span></span></button>
                <button class="action-tile edit" type="button" data-action="edit-operation" data-id="${escapeAttr(operation.id)}"><span class="tile-icon"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></span><span><strong>Modifier</strong><span>Mettre à jour l'opération</span></span></button>
                <button class="action-tile view" type="button" data-action="view-customer" data-id="${escapeAttr(customer ? customer.id : "")}"><span class="tile-icon"><i class="fa-solid fa-eye" aria-hidden="true"></i></span><span><strong>Voir le client</strong><span>Ouvrir la fiche liée</span></span></button>
                <button class="action-tile delete" type="button" data-action="delete-operation" data-id="${escapeAttr(operation.id)}"><span class="tile-icon"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></span><span><strong>Supprimer</strong><span>Retirer cette opération</span></span></button>
            </div></section>
        `;
    }

    function renderCustomerView(id) {
        const customer = getCustomer(id);
        if (!customer) return renderNotFound("Client introuvable", "Cette fiche client n'existe plus.", "#clients");
        const operations = state.operations.filter((operation) => operation.customerId === customer.id).sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const total = operations.reduce((sum, operation) => sum + operationTotal(operation), 0);
        return `
            <div class="detail-header"><div><a class="back-link" href="#clients"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>Retour aux clients</a><div class="detail-title"><span class="client-avatar" style="width:40px;height:40px;">${escapeHTML(initials(fullName(customer)))}</span><h1>${escapeHTML(fullName(customer))}</h1></div><div class="detail-meta">Fiche client · ${operations.length} opération${operations.length > 1 ? "s" : ""}</div></div><div class="detail-actions"><button class="btn btn-secondary" type="button" data-action="edit-customer" data-id="${escapeAttr(customer.id)}"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>Modifier</button><button class="btn btn-primary" type="button" data-action="create-invoice" data-id="${escapeAttr(customer.id)}"><i class="fa-solid fa-file-invoice" aria-hidden="true"></i>Créer une facture</button></div></div>
            <div class="info-grid">
                <div class="card info-card"><div class="info-label"><i class="fa-solid fa-phone" aria-hidden="true"></i>Téléphone</div><div class="info-value">${customer.phone ? escapeHTML(customer.phone) : "Non renseigné"}</div></div>
                <div class="card info-card"><div class="info-label"><i class="fa-solid fa-location-dot" aria-hidden="true"></i>Adresse</div><div class="info-value">${customer.address ? escapeHTML(customer.address) : "Non renseignée"}</div></div>
                <div class="card info-card"><div class="info-label"><i class="fa-solid fa-envelope" aria-hidden="true"></i>Email</div><div class="info-value">${customer.email ? escapeHTML(customer.email) : "Non renseigné"}</div></div>
                <div class="card info-card"><div class="info-label"><i class="fa-solid fa-coins" aria-hidden="true"></i>Total client</div><div class="info-value">${formatMoney(total)}</div></div>
            </div>
            <section class="card table-card"><div class="card-header"><div><h2>Opérations de ${escapeHTML(fullName(customer))}</h2><p>Seules les opérations liées à ce client sont affichées.</p></div><button class="btn btn-secondary btn-small" type="button" data-action="open-new-operation" data-customer-id="${escapeAttr(customer.id)}"><i class="fa-solid fa-plus" aria-hidden="true"></i>Ajouter</button></div>${operations.length ? `<div class="operation-list">${operations.map((operation) => renderOperationRow(operation)).join("")}</div>` : `<div class="empty-state"><i class="fa-solid fa-clipboard-list" aria-hidden="true"></i><strong>Aucune opération pour ce client</strong><p>Une facture vide pourra être imprimée tant qu'aucune opération n'est enregistrée.</p></div>`}</section>
        `;
    }

    function renderNotFound(title, copy, backHref) {
        return `<div class="empty-state" style="margin-top:70px;"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><strong>${escapeHTML(title)}</strong><p>${escapeHTML(copy)}</p><a class="btn btn-primary btn-small" href="${escapeAttr(backHref)}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>Retour</a></div>`;
    }

    function renderSettingsView() {
        const settings = state.settings;
        const products = [...state.products].sort((a, b) => String(a.name).localeCompare(String(b.name), "fr"));
        return `
            <div class="page-heading"><div><p class="eyebrow">Configuration</p><h1>Paramètres</h1><p>Les coordonnées ci-dessous alimentent automatiquement l'en-tête des certificats et des factures.</p></div></div>
            <div class="settings-layout">
                <section class="card settings-section"><div class="card-header"><div><h2>Informations de l'atelier</h2><p>Ces informations sont utilisées dans les documents imprimables.</p></div></div><div class="card-body">
                    <div class="logo-setting"><div class="logo-preview"><img src="${escapeAttr(settings.logo || "img/logo.png")}" alt="Logo de l'atelier"></div><div><strong>Logo de l'atelier</strong><p>Le logo enregistré dans Paramètres est repris dans les factures et documents.</p><div class="logo-actions"><button class="btn btn-secondary btn-small" type="button" data-action="upload-logo"><i class="fa-solid fa-upload" aria-hidden="true"></i>Changer le logo</button><span style="color:var(--muted);font-size:9px;">PNG, JPG ou WEBP</span></div></div></div>
                    <form id="settingsForm"><div class="form-grid"><div class="form-field full"><label for="settingsName">Nom de l'atelier</label><input id="settingsName" name="name" required value="${escapeAttr(settings.name)}"></div><div class="form-field"><label for="settingsPhone">Téléphone</label><input id="settingsPhone" name="phone" value="${escapeAttr(settings.phone)}" placeholder="Téléphone de l'atelier"></div><div class="form-field"><label for="settingsEmail">Email <span class="optional">(optionnel)</span></label><input id="settingsEmail" name="email" type="email" value="${escapeAttr(settings.email)}"></div><div class="form-field full"><label for="settingsAddress">Adresse</label><textarea id="settingsAddress" name="address" placeholder="Adresse de l'atelier">${escapeHTML(settings.address)}</textarea></div><div class="form-field full"><label for="settingsWebsite">Site web <span class="optional">(optionnel)</span></label><input id="settingsWebsite" name="website" value="${escapeAttr(settings.website)}"></div></div><div style="display:flex;justify-content:flex-end;margin-top:19px;"><button class="btn btn-primary" type="submit"><i class="fa-solid fa-check" aria-hidden="true"></i>Enregistrer les paramètres</button></div></form>
                </div></section>
                <section class="card settings-section"><div class="card-header"><div><h2>Catalogue produits</h2><p>Le prix enregistré est utilisé automatiquement pour une Réparation.</p></div><button class="btn btn-primary btn-small" type="button" data-action="add-product"><i class="fa-solid fa-plus" aria-hidden="true"></i>Ajouter</button></div><div class="card-body">${products.length ? `<div class="product-list">${products.map((product) => `<div class="product-item"><div class="product-info"><strong>${escapeHTML(product.name)}</strong><span>${formatMoney(product.price)}</span></div><div class="product-item-actions"><button class="action-icon" type="button" data-action="edit-product" data-id="${escapeAttr(product.id)}" title="Modifier" aria-label="Modifier"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button><button class="action-icon danger" type="button" data-action="delete-product" data-id="${escapeAttr(product.id)}" title="Supprimer" aria-label="Supprimer"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button></div></div>`).join("")}</div>` : `<div class="empty-state" style="padding:24px 5px;"><i class="fa-solid fa-box-open" aria-hidden="true"></i><strong>Aucun produit enregistré</strong><p>Ajoutez un produit avec son prix pour le proposer dans une opération de Réparation.</p><button class="btn btn-secondary btn-small" type="button" data-action="add-product"><i class="fa-solid fa-plus" aria-hidden="true"></i>Ajouter un produit</button></div>`}</div></section>
            </div>
        `;
    }

    function renderDocumentView(operationId, documentKey) {
        const operation = getOperation(operationId);
        const document = DOCUMENT_TYPES.find((item) => item.key === documentKey);
        if (!operation || !document) return renderNotFound("Document introuvable", "Le document demandé n'est pas disponible.", operation ? `#operation/${encodeURIComponent(operation.id)}` : "#operations");
        const customer = operationCustomer(operation);
        const settings = state.settings;
        return `
            <div class="document-page-wrap">
                <div class="document-toolbar print-exclude"><a class="back-link" href="#operation/${encodeURIComponent(operation.id)}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>Retour à l'opération</a><div class="document-toolbar-actions"><button class="btn btn-primary btn-small" type="button" data-action="print-document"><i class="fa-solid fa-print" aria-hidden="true"></i>Imprimer</button></div></div>
                <article class="document-page">
                    <div class="document-header"><div class="document-brand"><img src="${escapeAttr(settings.logo || "img/logo.png")}" alt="Logo de ${escapeAttr(settings.name)}"><div><strong>${escapeHTML(settings.name || "Atelier")}</strong><span>Document lié à l'opération ${escapeHTML(operation.id)}</span></div></div><div class="workshop-contact"><strong>Informations atelier</strong>${settings.phone ? `Téléphone : ${escapeHTML(settings.phone)}<br>` : ""}${settings.address ? `Adresse : ${escapeHTML(settings.address)}<br>` : ""}${settings.email ? escapeHTML(settings.email) : ""}</div></div>
                    <div class="document-title-block"><h1>${escapeHTML(document.label)}</h1><p>Référence opération : ${escapeHTML(operation.id)} · Date : ${formatDate(operation.date)}</p></div>
                    <div class="document-parties"><div class="document-party"><h2>Client</h2><p><strong>${escapeHTML(customer ? fullName(customer) : "Client introuvable")}</strong></p><p>Téléphone : ${escapeHTML(customer && customer.phone ? customer.phone : "Non renseigné")}</p><p>Adresse : ${escapeHTML(customer && customer.address ? customer.address : "Non renseignée")}</p>${customer && customer.email ? `<p>Email : ${escapeHTML(customer.email)}</p>` : ""}</div><div class="document-party"><h2>Opération</h2><p>Type : <strong>${escapeHTML(operation.type || "Opération")}</strong></p><p>Désignation : ${escapeHTML(operationDesignation(operation))}</p><p>Quantité : ${numberOr(operation.quantity, 1)}</p><p>Prix total : <strong>${formatMoney(operationTotal(operation))}</strong></p></div></div>
                    <table class="document-info-table"><tbody><tr><td>Nom et prénom du client</td><td>${escapeHTML(customer ? fullName(customer) : "Client introuvable")}</td></tr><tr><td>Téléphone</td><td>${escapeHTML(customer && customer.phone ? customer.phone : "Non renseigné")}</td></tr><tr><td>Adresse</td><td>${escapeHTML(customer && customer.address ? customer.address : "Non renseignée")}</td></tr><tr><td>Opération concernée</td><td>${escapeHTML(operationDesignation(operation))} · ${formatDate(operation.date)}</td></tr></tbody></table>
                    <p class="document-note">Ce document est généré à partir de la fiche client et de l'opération sélectionnée. Aucune sélection supplémentaire du client n'est nécessaire.</p>
                    <div class="signature-row"><div class="signature">Signature / cachet de l'atelier</div></div>
                    <div class="document-footer"><span>${escapeHTML(settings.name || "Atelier")}</span><span>${escapeHTML(settings.phone || "")}${settings.address ? ` · ${escapeHTML(settings.address)}` : ""}</span></div>
                </article>
            </div>
        `;
    }

    function getInvoiceLines(customerId) {
        const operations = state.operations.filter((operation) => operation.customerId === customerId).sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const lines = [];
        operations.forEach((operation) => {
            if (Array.isArray(operation.items) && operation.items.length) {
                operation.items.forEach((item) => {
                    lines.push({
                        date: operation.date,
                        designation: item.designation || item.name || operationDesignation(operation),
                        quantity: Math.max(numberOr(item.quantity, 1), 0),
                        unitPrice: numberOr(item.unitPrice, 0),
                        total: numberOr(item.unitPrice, 0) * Math.max(numberOr(item.quantity, 1), 0)
                    });
                });
            } else {
                lines.push({
                    date: operation.date,
                    designation: operationDesignation(operation),
                    quantity: Math.max(numberOr(operation.quantity, 1), 0),
                    unitPrice: numberOr(operation.unitPrice, 0),
                    total: operationTotal(operation)
                });
            }
        });
        return lines;
    }

    function renderInvoiceView(customerId) {
        const customer = getCustomer(customerId);
        if (!customer) return renderNotFound("Client introuvable", "Impossible de créer cette facture sans la fiche client.", "#clients");
        const settings = state.settings;
        const lines = getInvoiceLines(customer.id);
        const total = lines.reduce((sum, line) => sum + line.total, 0);
        const invoiceReference = `FAC-${String(customer.id).slice(-8).toUpperCase()}`;
        return `
            <div class="document-page-wrap">
                <div class="document-toolbar print-exclude"><a class="back-link" href="#client/${encodeURIComponent(customer.id)}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>Retour à la fiche client</a><div class="document-toolbar-actions"><button class="btn btn-primary btn-small" type="button" data-action="print-invoice"><i class="fa-solid fa-print" aria-hidden="true"></i>Imprimer / PDF</button></div></div>
                <article class="invoice-page">
                    <div class="invoice-header"><div class="invoice-brand"><img src="${escapeAttr(settings.logo || "img/logo.png")}" alt="Logo de ${escapeAttr(settings.name)}"><div><strong>${escapeHTML(settings.name || "Atelier")}</strong><span>Facture client</span></div></div><div class="workshop-contact"><strong>${escapeHTML(settings.name || "Atelier")}</strong>${settings.phone ? `Téléphone : ${escapeHTML(settings.phone)}<br>` : ""}${settings.address ? `Adresse : ${escapeHTML(settings.address)}<br>` : ""}${settings.email ? escapeHTML(settings.email) : ""}</div></div>
                    <div class="invoice-title-line"><h1>Facture</h1><div class="invoice-reference"><strong>${escapeHTML(invoiceReference)}</strong><br>Date : ${formatDate(TODAY)}</div></div>
                    <div class="invoice-client"><div class="invoice-client-box"><h2>Facturé à</h2><p><strong>${escapeHTML(fullName(customer))}</strong></p><p>Téléphone : ${escapeHTML(customer.phone || "Non renseigné")}</p><p>Adresse : ${escapeHTML(customer.address || "Non renseignée")}</p></div></div>
                    <div class="invoice-lines"><table><thead><tr><th>Date</th><th>Désignation</th><th>Quantité</th><th>Prix unitaire</th><th>Total</th></tr></thead><tbody>${lines.length ? lines.map((line) => `<tr><td>${formatDate(line.date)}</td><td>${escapeHTML(line.designation)}</td><td>${line.quantity}</td><td>${formatMoney(line.unitPrice)}</td><td>${formatMoney(line.total)}</td></tr>`).join("") : `<tr class="empty-row"><td colspan="5">Aucune opération enregistrée pour ce client</td></tr>`}</tbody></table></div>
                    <div class="invoice-total"><div class="total-box"><span>Total à payer</span><strong>${formatMoney(total)}</strong></div></div>
                    <div class="invoice-footer"><span><strong>${escapeHTML(settings.name || "Atelier")}</strong></span><span>${escapeHTML(settings.phone || "")}${settings.address ? ` · ${escapeHTML(settings.address)}` : ""}</span></div>
                </article>
            </div>
        `;
    }

    function customerOptions(selectedId = "") {
        if (!state.customers.length) return `<option value="">Aucun client enregistré</option>`;
        return `<option value="">Sélectionner un client…</option>${state.customers.map((customer) => `<option value="${escapeAttr(customer.id)}" ${customer.id === selectedId ? "selected" : ""}>${escapeHTML(fullName(customer))} — ${escapeHTML(customer.phone || "téléphone non renseigné")}</option>`).join("")}`;
    }

    function productOptions(selectedId = "") {
        const current = selectedId && getProduct(selectedId);
        const products = [...state.products];
        if (current && !products.some((product) => product.id === current.id)) products.push(current);
        return `<option value="">Aucun produit — service libre</option>${products.map((product) => `<option value="${escapeAttr(product.id)}" ${product.id === selectedId ? "selected" : ""}>${escapeHTML(product.name)} — ${formatMoney(product.price)}</option>`).join("")}`;
    }

    function openCustomerModal(id = "") {
        const customer = id ? getCustomer(id) : null;
        modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="customerModalTitle"><div class="modal-head"><div><h2 id="customerModalTitle">${customer ? "Modifier le client" : "Nouveau client"}</h2><p>Les informations saisies seront réutilisées dans les opérations et documents.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Fermer"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div><form id="customerForm"><div class="modal-body"><input type="hidden" name="id" value="${escapeAttr(customer ? customer.id : "")}"><div class="form-grid"><div class="form-field"><label for="customerFirstName">Prénom</label><input id="customerFirstName" name="firstName" required value="${escapeAttr(customer ? customer.firstName : "")}" autocomplete="given-name"></div><div class="form-field"><label for="customerLastName">Nom</label><input id="customerLastName" name="lastName" required value="${escapeAttr(customer ? customer.lastName : "")}" autocomplete="family-name"></div><div class="form-field"><label for="customerPhone">Téléphone</label><input id="customerPhone" name="phone" required value="${escapeAttr(customer ? customer.phone : "")}" autocomplete="tel"></div><div class="form-field"><label for="customerEmail">Email <span class="optional">(optionnel)</span></label><input id="customerEmail" name="email" type="email" value="${escapeAttr(customer ? customer.email : "")}" autocomplete="email"></div><div class="form-field full"><label for="customerAddress">Adresse <span class="optional">(optionnel)</span></label><textarea id="customerAddress" name="address" placeholder="Adresse du client" autocomplete="street-address">${escapeHTML(customer ? customer.address : "")}</textarea><p class="form-hint">L'adresse est enregistrée dans la fiche client et affichée dans les documents et factures lorsqu'elle est renseignée.</p></div></div></div><div class="modal-footer"><button class="btn btn-secondary" type="button" data-action="close-modal">Annuler</button><button class="btn btn-primary" type="submit"><i class="fa-solid fa-check" aria-hidden="true"></i>Enregistrer</button></div></form></section></div>`;
        focusFirstModalField();
    }

    function openOperationModal(id = "", customerId = "") {
        const operation = id ? getOperation(id) : null;
        const selectedCustomer = operation ? operation.customerId : customerId;
        const selectedProduct = operation ? operation.productId || "" : "";
        const type = operation ? operation.type : "Réparation";
        const product = getProduct(selectedProduct);
        const initialPrice = type === "Réparation" && product ? product.price : operation ? operation.unitPrice : "";
        const noCustomers = state.customers.length === 0;
        modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-backdrop><section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="operationModalTitle"><div class="modal-head"><div><h2 id="operationModalTitle">${operation ? "Modifier l'opération" : "Nouvelle opération"}</h2><p>Pour une Réparation, le prix du produit sélectionné est repris du catalogue.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Fermer"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div><form id="operationForm"><div class="modal-body">${noCustomers ? `<p class="form-error">Ajoutez d'abord un client dans « Clients &amp; Opérations ».</p>` : ""}<input type="hidden" name="id" value="${escapeAttr(operation ? operation.id : "")}"><div class="form-grid"><div class="form-field full"><label for="operationCustomer">Client</label><select id="operationCustomer" name="customerId" required>${customerOptions(selectedCustomer)}</select></div><div class="form-field"><label for="operationType">Type d'opération</label><select id="operationType" name="type" data-operation-type required>${OPERATION_TYPES.map((item) => `<option value="${escapeAttr(item)}" ${item === type ? "selected" : ""}>${escapeHTML(item)}</option>`).join("")}</select></div><div class="form-field"><label for="operationDate">Date</label><input id="operationDate" type="date" name="date" required value="${escapeAttr(operation ? operation.date : TODAY)}"></div><div class="form-field full"><label for="operationProduct">Produit <span class="optional">(optionnel)</span></label><select id="operationProduct" name="productId" data-operation-product>${productOptions(selectedProduct)}</select><p class="form-hint">Pour « Réparation », choisir un produit applique immédiatement son prix enregistré.</p></div><div class="form-field"><label for="operationDesignation">Désignation</label><input id="operationDesignation" name="designation" value="${escapeAttr(operation ? operation.designation || "" : "")}" placeholder="Service ou produit"></div><div class="form-field"><label for="operationQuantity">Quantité</label><input id="operationQuantity" name="quantity" data-operation-quantity type="number" min="0.01" step="0.01" value="${escapeAttr(operation ? numberOr(operation.quantity, 1) : 1)}" required></div><div class="form-field"><label for="operationPrice">Prix unitaire</label><input id="operationPrice" name="unitPrice" data-operation-price type="number" min="0" step="0.01" value="${escapeAttr(initialPrice)}" ${type === "Réparation" && product ? "readonly" : ""} required><p class="form-hint">Montant en DA. Le prix d'un produit de Réparation vient du catalogue.</p></div><div class="form-field"><label>Total</label><div class="price-preview"><span>Prix total</span><strong data-operation-total>${formatMoney(numberOr(initialPrice, 0) * numberOr(operation ? operation.quantity : 1, 1))}</strong></div></div></div></div><div class="modal-footer"><button class="btn btn-secondary" type="button" data-action="close-modal">Annuler</button><button class="btn btn-primary" type="submit" ${noCustomers ? "disabled" : ""}><i class="fa-solid fa-check" aria-hidden="true"></i>Enregistrer l'opération</button></div></form></section></div>`;
        syncOperationPriceFields($("#operationForm"));
        focusFirstModalField();
    }

    function openDocumentsModal(id) {
        const operation = getOperation(id);
        if (!operation) return showToast("Opération introuvable.", true);
        const customer = operationCustomer(operation);
        modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="documentsModalTitle"><div class="modal-head"><div><h2 id="documentsModalTitle">Documents</h2><p>${escapeHTML(customer ? fullName(customer) : "Client introuvable")} · ${escapeHTML(operationDesignation(operation))}</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Fermer"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div><div class="modal-body"><div class="documents-list">${DOCUMENT_TYPES.map((document) => `<button class="document-option" type="button" data-action="open-document" data-id="${escapeAttr(operation.id)}" data-document-type="${escapeAttr(document.key)}"><i class="fa-solid ${escapeAttr(document.icon)}" aria-hidden="true"></i><span><strong>${escapeHTML(document.label)}</strong><span>${escapeHTML(document.hint)} · ${escapeHTML(fullName(customer))}</span></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`).join("")}</div></div></section></div>`;
    }

    function openProductModal(id = "") {
        const product = id ? getProduct(id) : null;
        modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="productModalTitle"><div class="modal-head"><div><h2 id="productModalTitle">${product ? "Modifier le produit" : "Ajouter un produit"}</h2><p>Le prix sera disponible pour les opérations de Réparation.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Fermer"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div><form id="productForm"><div class="modal-body"><input type="hidden" name="id" value="${escapeAttr(product ? product.id : "")}"><div class="form-grid"><div class="form-field full"><label for="productName">Nom du produit</label><input id="productName" name="name" required value="${escapeAttr(product ? product.name : "")}" placeholder="Ex. Kit GPL"></div><div class="form-field"><label for="productPrice">Prix enregistré</label><input id="productPrice" name="price" type="number" min="0" step="0.01" required value="${escapeAttr(product ? product.price : "")}" placeholder="0"></div><div class="form-field"><label>Unité</label><input value="DA" readonly></div></div></div><div class="modal-footer"><button class="btn btn-secondary" type="button" data-action="close-modal">Annuler</button><button class="btn btn-primary" type="submit"><i class="fa-solid fa-check" aria-hidden="true"></i>Enregistrer</button></div></form></section></div>`;
        focusFirstModalField();
    }

    function openConfirmModal({ title, copy, confirmLabel, action, id, danger = false }) {
        modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="confirmModalTitle"><div class="modal-head"><div><h2 id="confirmModalTitle">${escapeHTML(title)}</h2></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Fermer"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div><div class="modal-body"><p class="confirm-copy">${copy}</p></div><div class="modal-footer"><button class="btn btn-secondary" type="button" data-action="close-modal">Annuler</button><button class="btn ${danger ? "btn-danger" : "btn-primary"}" type="button" data-action="${escapeAttr(action)}" data-id="${escapeAttr(id)}">${danger ? `<i class="fa-solid fa-trash-can" aria-hidden="true"></i>` : `<i class="fa-solid fa-check" aria-hidden="true"></i>`}${escapeHTML(confirmLabel)}</button></div></section></div>`;
    }

    function focusFirstModalField() {
        window.setTimeout(() => {
            const first = $(".modal input:not([type=hidden]), .modal select, .modal textarea");
            if (first) first.focus();
        }, 40);
    }

    function closeModal() {
        modalRoot.innerHTML = "";
    }

    function syncOperationPriceFields(form) {
        if (!form) return;
        const type = $("[data-operation-type]", form)?.value;
        const productId = $("[data-operation-product]", form)?.value;
        const product = getProduct(productId);
        const priceInput = $("[data-operation-price]", form);
        if (!priceInput) return;
        if (type === "Réparation" && product) {
            priceInput.value = product.price;
            priceInput.readOnly = true;
        } else {
            priceInput.readOnly = false;
        }
        updateOperationTotal(form);
    }

    function updateOperationTotal(form) {
        if (!form) return;
        const price = numberOr($("[data-operation-price]", form)?.value, 0);
        const quantity = numberOr($("[data-operation-quantity]", form)?.value, 0);
        const total = $("[data-operation-total]", form);
        if (total) total.textContent = formatMoney(price * quantity);
    }

    function handleCustomerSubmit(form) {
        const values = Object.fromEntries(new FormData(form).entries());
        const firstName = String(values.firstName || "").trim();
        const lastName = String(values.lastName || "").trim();
        const phone = String(values.phone || "").trim();
        const address = String(values.address || "").trim();
        if (!firstName || !lastName || !phone) {
            showFormError(form, "Le prénom, le nom et le téléphone sont obligatoires.");
            return;
        }
        const record = { firstName, lastName, phone, address, email: String(values.email || "").trim() };
        if (values.id) {
            const index = state.customers.findIndex((customer) => customer.id === values.id);
            if (index !== -1) state.customers[index] = { ...state.customers[index], ...record };
        } else {
            record.id = uid("customer");
            record.createdAt = new Date().toISOString();
            state.customers.push(record);
            addNotification(`Nouveau client enregistré : ${fullName(record)}`);
        }
        saveState();
        closeModal();
        render();
        showToast(values.id ? "La fiche client a été mise à jour." : "Le client a été enregistré.");
    }

    function handleOperationSubmit(form) {
        const values = Object.fromEntries(new FormData(form).entries());
        const customer = getCustomer(values.customerId);
        const type = String(values.type || "").trim();
        const product = getProduct(values.productId);
        const quantity = numberOr(values.quantity, 0);
        let unitPrice = numberOr(values.unitPrice, 0);
        if (!customer || !type || !values.date || quantity <= 0) {
            showFormError(form, "Sélectionnez un client, un type, une date et une quantité valide.");
            return;
        }
        // For repairs the database/catalogue is authoritative, never a manually changed input.
        if (type === "Réparation" && product) unitPrice = numberOr(product.price, 0);
        if (unitPrice < 0) {
            showFormError(form, "Le prix ne peut pas être négatif.");
            return;
        }
        const designation = String(values.designation || "").trim() || (product ? product.name : type);
        const total = unitPrice * quantity;
        const record = {
            customerId: customer.id,
            type,
            productId: product ? product.id : "",
            designation,
            quantity,
            unitPrice,
            total,
            date: values.date,
            updatedAt: new Date().toISOString()
        };
        if (values.id) {
            const index = state.operations.findIndex((operation) => operation.id === values.id);
            if (index !== -1) state.operations[index] = { ...state.operations[index], ...record };
        } else {
            record.id = uid("operation");
            record.createdAt = new Date().toISOString();
            state.operations.push(record);
            addNotification(`Nouvelle opération pour ${fullName(customer)}`);
        }
        saveState();
        closeModal();
        navigate(`#operation/${encodeURIComponent(values.id || record.id)}`);
        showToast(values.id ? "L'opération a été mise à jour." : "L'opération a été enregistrée.");
    }

    function handleSettingsSubmit(form) {
        const values = Object.fromEntries(new FormData(form).entries());
        const name = String(values.name || "").trim();
        if (!name) {
            showFormError(form, "Le nom de l'atelier est obligatoire.");
            return;
        }
        state.settings = { ...state.settings, name, phone: String(values.phone || "").trim(), address: String(values.address || "").trim(), email: String(values.email || "").trim(), website: String(values.website || "").trim() };
        saveState();
        render();
        showToast("Les paramètres de l'atelier ont été enregistrés.");
    }

    function handleProductSubmit(form) {
        const values = Object.fromEntries(new FormData(form).entries());
        const name = String(values.name || "").trim();
        const price = numberOr(values.price, -1);
        if (!name || price < 0) {
            showFormError(form, "Saisissez un nom et un prix valide.");
            return;
        }
        const record = { name, price, updatedAt: new Date().toISOString() };
        if (values.id) {
            const index = state.products.findIndex((product) => product.id === values.id);
            if (index !== -1) state.products[index] = { ...state.products[index], ...record };
        } else {
            record.id = uid("product");
            state.products.push(record);
        }
        saveState();
        closeModal();
        render();
        showToast(values.id ? "Le produit a été mis à jour." : "Le produit a été ajouté au catalogue.");
    }

    function showFormError(form, message) {
        const existing = $(".form-error", form);
        if (existing) existing.remove();
        const error = document.createElement("p");
        error.className = "form-error";
        error.textContent = message;
        const body = $(".modal-body", form);
        if (body) body.prepend(error);
    }

    function addNotification(message) {
        state.notifications.unshift({ id: uid("notification"), message, date: new Date().toISOString(), read: false });
        state.notifications = state.notifications.slice(0, 30);
    }

    function updateNotificationUI() {
        const unread = state.notifications.filter((notification) => !notification.read).length;
        const badge = $("#notificationBadge");
        if (badge) {
            badge.textContent = unread > 99 ? "99+" : String(unread);
            badge.classList.toggle("is-hidden", unread === 0);
        }
        renderNotificationPanel();
    }

    function renderNotificationPanel() {
        const panel = $("#notificationPanel");
        if (!panel) return;
        const unread = state.notifications.filter((notification) => !notification.read).length;
        panel.innerHTML = `<div class="notification-panel-head"><strong>Notifications</strong>${unread ? `<button type="button" data-action="mark-notifications-read">Tout marquer comme lu</button>` : ""}</div>${state.notifications.length ? `<div class="notification-list">${state.notifications.map((notification) => `<div class="notification-item ${notification.read ? "" : "unread"}"><i class="fa-solid ${notification.read ? "fa-circle-check" : "fa-circle-info"}" aria-hidden="true"></i><p>${escapeHTML(notification.message)}<time>${escapeHTML(notification.date ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(notification.date)) : "")}</time></p></div>`).join("")}</div>` : `<div class="notification-empty">Aucune notification pour le moment.</div>`}`;
    }

    function showToast(message, error = false) {
        const region = $("#toastRegion");
        if (!region) return;
        const toast = document.createElement("div");
        toast.className = `toast ${error ? "error" : ""}`;
        toast.innerHTML = `<i class="fa-solid ${error ? "fa-circle-exclamation" : "fa-circle-check"}" aria-hidden="true"></i><span>${escapeHTML(message)}</span>`;
        region.appendChild(toast);
        window.setTimeout(() => toast.remove(), 3600);
    }

    function requestDeleteCustomer(id) {
        const customer = getCustomer(id);
        if (!customer) return;
        const count = state.operations.filter((operation) => operation.customerId === id).length;
        if (count) {
            openConfirmModal({
                title: "Client lié à des opérations",
                copy: `Le client <strong>${escapeHTML(fullName(customer))}</strong> possède ${count} opération${count > 1 ? "s" : ""}. Pour préserver les relations existantes, sa suppression est bloquée. Vous pouvez modifier sa fiche à la place.`,
                confirmLabel: "Modifier la fiche",
                action: "edit-customer",
                id
            });
            return;
        }
        openConfirmModal({ title: "Supprimer ce client ?", copy: `La fiche de <strong>${escapeHTML(fullName(customer))}</strong> sera supprimée. Cette action ne peut pas être annulée.`, confirmLabel: "Supprimer", action: "confirm-delete-customer", id, danger: true });
    }

    function deleteCustomer(id) {
        const index = state.customers.findIndex((customer) => customer.id === id);
        if (index === -1) return;
        state.customers.splice(index, 1);
        saveState();
        closeModal();
        render();
        showToast("La fiche client a été supprimée.");
    }

    function requestDeleteOperation(id) {
        const operation = getOperation(id);
        if (!operation) return;
        const customer = operationCustomer(operation);
        openConfirmModal({ title: "Supprimer cette opération ?", copy: `L'opération <strong>${escapeHTML(operationDesignation(operation))}</strong>${customer ? ` de ${escapeHTML(fullName(customer))}` : ""} sera supprimée.`, confirmLabel: "Supprimer", action: "confirm-delete-operation", id, danger: true });
    }

    function deleteOperation(id) {
        const index = state.operations.findIndex((operation) => operation.id === id);
        if (index === -1) return;
        state.operations.splice(index, 1);
        saveState();
        closeModal();
        navigate("#operations");
        showToast("L'opération a été supprimée.");
    }

    function deleteProduct(id) {
        const product = getProduct(id);
        if (!product) return;
        if (state.operations.some((operation) => operation.productId === id)) {
            showToast("Ce produit est utilisé par une opération et ne peut pas être supprimé.", true);
            return;
        }
        state.products = state.products.filter((item) => item.id !== id);
        saveState();
        render();
        showToast("Le produit a été supprimé du catalogue.");
    }

    function triggerPrint() {
        window.setTimeout(() => window.print(), 80);
    }

    function toggleSidebar() {
        const sidebar = $("#sidebar");
        const button = $("#mobileMenuButton");
        if (!sidebar || !button) return;
        const open = sidebar.classList.toggle("is-open");
        button.setAttribute("aria-expanded", String(open));
    }

    function handleClick(event) {
        const viewLink = event.target.closest("[data-view]");
        if (viewLink) {
            const sidebar = $("#sidebar");
            if (sidebar) sidebar.classList.remove("is-open");
            return;
        }
        const actionElement = event.target.closest("[data-action]");
        if (!actionElement) return;
        const action = actionElement.dataset.action;
        const id = actionElement.dataset.id || "";
        switch (action) {
            case "mobile-menu":
                toggleSidebar();
                break;
            case "toggle-notifications": {
                const panel = $("#notificationPanel");
                const button = $("#notificationButton");
                const isOpen = panel && !panel.classList.contains("is-hidden");
                if (panel) panel.classList.toggle("is-hidden", isOpen);
                if (button) button.setAttribute("aria-expanded", String(!isOpen));
                break;
            }
            case "mark-notifications-read":
                state.notifications.forEach((notification) => { notification.read = true; });
                saveState();
                updateNotificationUI();
                break;
            case "open-new-customer":
                openCustomerModal();
                break;
            case "edit-customer":
                openCustomerModal(id);
                break;
            case "delete-customer":
                requestDeleteCustomer(id);
                break;
            case "confirm-delete-customer":
                deleteCustomer(id);
                break;
            case "view-customer":
                if (id) navigate(`#client/${encodeURIComponent(id)}`);
                break;
            case "create-invoice":
                if (getCustomer(id)) navigate(`#invoice/${encodeURIComponent(id)}`);
                else showToast("Client introuvable.", true);
                break;
            case "open-new-operation":
                openOperationModal("", actionElement.dataset.customerId || "");
                break;
            case "view-operation":
                if (id) navigate(`#operation/${encodeURIComponent(id)}`);
                break;
            case "edit-operation":
                openOperationModal(id);
                break;
            case "delete-operation":
                requestDeleteOperation(id);
                break;
            case "confirm-delete-operation":
                deleteOperation(id);
                break;
            case "open-documents":
                openDocumentsModal(id);
                break;
            case "open-document":
                closeModal();
                navigate(`#document/${encodeURIComponent(id)}/${encodeURIComponent(actionElement.dataset.documentType || "")}`);
                break;
            case "close-modal":
                closeModal();
                break;
            case "print-invoice":
            case "print-document":
                triggerPrint();
                break;
            case "upload-logo":
                if (logoFileInput) logoFileInput.click();
                break;
            case "add-product":
                openProductModal();
                break;
            case "edit-product":
                openProductModal(id);
                break;
            case "delete-product":
                deleteProduct(id);
                break;
            default:
                break;
        }
    }

    function handleInput(event) {
        if (event.target.matches("[data-customer-filter]")) {
            currentCustomerFilter = event.target.value;
            renderClientsTable(currentCustomerFilter);
        }
        if (event.target.matches("[data-operation-filter]")) {
            currentOperationFilter = event.target.value;
            renderOperationsTable(currentOperationFilter);
        }
        if (event.target.matches("[data-operation-quantity], [data-operation-price]")) updateOperationTotal(event.target.closest("form"));
    }

    function handleChange(event) {
        if (event.target.matches("[data-operation-product], [data-operation-type]")) syncOperationPriceFields(event.target.closest("form"));
    }

    function handleSubmit(event) {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        event.preventDefault();
        if (form.id === "customerForm") handleCustomerSubmit(form);
        if (form.id === "operationForm") handleOperationSubmit(form);
        if (form.id === "settingsForm") handleSettingsSubmit(form);
        if (form.id === "productForm") handleProductSubmit(form);
    }

    function handleLogoChange(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            showToast("Sélectionnez une image PNG, JPG ou WEBP.", true);
            event.target.value = "";
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            showToast("Le logo doit faire moins de 5 Mo.", true);
            event.target.value = "";
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            state.settings.logo = String(reader.result);
            saveState();
            render();
            showToast("Le logo de l'atelier a été mis à jour.");
            event.target.value = "";
        };
        reader.onerror = () => showToast("Impossible de lire cette image.", true);
        reader.readAsDataURL(file);
    }

    document.addEventListener("click", handleClick);
    document.addEventListener("input", handleInput);
    document.addEventListener("change", handleChange);
    document.addEventListener("submit", handleSubmit);
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            if (modalRoot.innerHTML) closeModal();
            const panel = $("#notificationPanel");
            if (panel) panel.classList.add("is-hidden");
        }
    });
    $("#notificationButton")?.addEventListener("click", () => {
        const panel = $("#notificationPanel");
        const button = $("#notificationButton");
        if (!panel) return;
        const open = panel.classList.toggle("is-hidden");
        button?.setAttribute("aria-expanded", String(!open));
    });
    $("#mobileMenuButton")?.addEventListener("click", toggleSidebar);
    logoFileInput?.addEventListener("change", handleLogoChange);
    window.addEventListener("hashchange", render);

    render();
})();

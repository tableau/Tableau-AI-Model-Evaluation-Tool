/**
 * The dashboard side panel of a Dashboard Narratives run: the live dashboard
 * through Tableau's Embedding API when its address is known, the case's
 * picture otherwise, and the form an admin saves the address with.
 *
 * The Embedding API script lands in document.head, which Testing Library has
 * no query for, so the tests look there directly.
 */
/* eslint-disable testing-library/no-node-access */

import React from "react";
import "@testing-library/jest-dom";
// Testing-library with a DOM for bun test.
import { act, fireEvent, render, screen, waitFor } from "./testing.cjs";
import { DashboardPanel } from "./DashboardPanel";
import { embedUrlOf, loadEmbeddingApi } from "./tableauEmbed";

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

const INFO = {
  id: "abc123",
  dashboard_id: "SplitsOverview",
  name: "Splits Overview",
  views: [{ name: "Fastest Splits", outliers: 2, insights: 1 }],
  has_image: true,
};

const open = () =>
  render(<DashboardPanel dashboard={{ jobId: "dn1", caseId: "abc123", name: "Splits Overview" }} onClose={() => {}} />);

afterEach(() => {
  document.head.querySelectorAll("script[data-tableau-embedding]").forEach((s) => s.remove());
});

describe("embedUrlOf", () => {
  it("turns the links people copy into the address the viz element takes", () => {
    expect(embedUrlOf("https://srv.example.com/#/site/eval/views/Splits/Overview?:iid=3")).toBe(
      "https://srv.example.com/t/eval/views/Splits/Overview",
    );
    expect(embedUrlOf("https://srv.example.com/#/views/Splits/Overview")).toBe(
      "https://srv.example.com/views/Splits/Overview",
    );
    expect(embedUrlOf("https://public.tableau.com/app/profile/ann/viz/CovidTracker/Global")).toBe(
      "https://public.tableau.com/views/CovidTracker/Global",
    );
    expect(embedUrlOf("https://public.tableau.com/views/CovidTracker/Global?:language=en-US&:display_count=n")).toBe(
      "https://public.tableau.com/views/CovidTracker/Global",
    );
    expect(embedUrlOf("https://public.tableau.com/shared/ABC123XYZ?:display_count=n")).toBe(
      "https://public.tableau.com/shared/ABC123XYZ",
    );
    expect(embedUrlOf("https://srv.example.com/t/eval/views/Splits/Overview/")).toBe(
      "https://srv.example.com/t/eval/views/Splits/Overview",
    );
  });

  it("gives nothing for links that are not a view", () => {
    expect(embedUrlOf("https://public.tableau.com/example")).toBeNull();
    expect(embedUrlOf("https://srv.example.com/#/site/eval/workbooks/12")).toBeNull();
    expect(embedUrlOf("ftp://srv.example.com/views/a/b")).toBeNull();
    expect(embedUrlOf("not a link")).toBeNull();
    expect(embedUrlOf(null)).toBeNull();
  });
});

describe("loadEmbeddingApi", () => {
  it("loads Tableau's script from the dashboard's server once", () => {
    loadEmbeddingApi("https://embed-once.example.com");
    loadEmbeddingApi("https://embed-once.example.com");
    const scripts = document.head.querySelectorAll('script[data-tableau-embedding="https://embed-once.example.com"]');
    expect(scripts).toHaveLength(1);
    expect((scripts[0] as HTMLScriptElement).src).toBe(
      "https://embed-once.example.com/javascripts/api/tableau.embedding.3.latest.min.js",
    );
    expect((scripts[0] as HTMLScriptElement).type).toBe("module");
  });
});

describe("DashboardPanel", () => {
  it("embeds the dashboard the case says it is about", async () => {
    (global as any).fetch = jest.fn(() =>
      json({ ...INFO, url: "https://public.tableau.com/app/profile/ann/viz/Splits/Overview", url_source: "case", source: "Tableau Public" }),
    );
    open();
    const viz = await screen.findByTestId("tableau-viz");
    expect(viz.getAttribute("src")).toBe("https://public.tableau.com/views/Splits/Overview");
    expect(viz.getAttribute("toolbar")).toBe("hidden");
    expect(viz.hasAttribute("hide-tabs")).toBe(true);
    await waitFor(() =>
      expect(document.head.querySelector('script[data-tableau-embedding="https://public.tableau.com"]')).not.toBeNull(),
    );
    expect(screen.queryByAltText("The dashboard Splits Overview")).toBeNull();
    expect(screen.getByText(/shown live from public\.tableau\.com/)).toBeInTheDocument();
    expect(screen.getByText("Open the dashboard (Tableau Public)")).toHaveAttribute(
      "href",
      "https://public.tableau.com/app/profile/ann/viz/Splits/Overview",
    );
    // The case's own address is not for the admin to change, and the live
    // dashboard stands alone: no table of views under it.
    expect(screen.queryByText("Change Address")).toBeNull();
    expect(screen.queryByText("Fastest Splits")).toBeNull();
  });

  it("falls back to the picture when the view does not load", async () => {
    (global as any).fetch = jest.fn(() =>
      json({ ...INFO, url: "https://srv.example.com/#/site/s/views/Splits/Overview", url_source: "saved" }),
    );
    open();
    const viz = await screen.findByTestId("tableau-viz");
    act(() => {
      viz.dispatchEvent(new CustomEvent("vizloaderror", { detail: { message: "Sign in required." } }));
    });
    expect(screen.queryByTestId("tableau-viz")).toBeNull();
    expect(screen.getByAltText("The dashboard Splits Overview")).toHaveAttribute(
      "src",
      expect.stringContaining("/nlq-eval/dashboards/dn1/abc123/image"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Sign in required.");
    expect(screen.getByRole("status")).toHaveTextContent("sign in to srv.example.com");
    // The picture comes with the table of views.
    expect(screen.getByText("Fastest Splits")).toBeInTheDocument();
  });

  it("shows the picture and asks for the address when the case has none, then saves it", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    (global as any).fetch = jest.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "PUT") {
        return json({ ...INFO, url: "https://srv.example.com/#/site/s/views/Splits/Overview", url_source: "saved" });
      }
      return json({ ...INFO, url: null, url_source: null });
    });
    open();
    expect(await screen.findByAltText("The dashboard Splits Overview")).toBeInTheDocument();
    expect(screen.queryByTestId("tableau-viz")).toBeNull();
    expect(screen.getByText(/does not record where its dashboard is published/)).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/does not record where/), {
      target: { value: "https://srv.example.com/#/site/s/views/Splits/Overview" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The save is a round trip through the mocked fetch and a re-render; a slow
    // CI runner needs more than the one-second default.
    const viz = await screen.findByTestId("tableau-viz", {}, { timeout: 5000 });
    expect(viz.getAttribute("src")).toBe("https://srv.example.com/t/s/views/Splits/Overview");
    const put = calls.find((c) => c.init?.method === "PUT")!;
    expect(put.url).toContain("/nlq-eval/dashboards/dn1/abc123/location");
    expect(JSON.parse(put.init!.body as string)).toEqual({ url: "https://srv.example.com/#/site/s/views/Splits/Overview" });
    // A saved address can be changed or forgotten.
    expect(screen.getByText("Change Address")).toBeInTheDocument();
  });

  it("explains when the server could not save the address", async () => {
    (global as any).fetch = jest.fn((url: string, init?: RequestInit) =>
      init?.method === "PUT" ? json({ error: "Enter the dashboard's address as a web link." }, 400) : json({ ...INFO, url: null }),
    );
    open();
    await screen.findByAltText("The dashboard Splits Overview");
    fireEvent.change(screen.getByLabelText(/does not record where/), { target: { value: "https://x.example/other" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Enter the dashboard's address as a web link."), { timeout: 5000 });
    expect(screen.queryByTestId("tableau-viz")).toBeNull();
  });

  it("heads the panel with the case's descriptive title and names the sheet under it", async () => {
    (global as any).fetch = jest.fn(() =>
      json({ ...INFO, name: "main page", title: "Urban Audit City Factsheets", url: null }),
    );
    open();
    expect(await screen.findByText("Dashboard: Urban Audit City Factsheets")).toBeInTheDocument();
    expect(screen.getByText("Dashboard sheet: main page")).toBeInTheDocument();
  });

  it("keeps the picture when the recorded address is not a view link", async () => {
    (global as any).fetch = jest.fn(() => json({ ...INFO, url: "https://public.tableau.com/example", url_source: "case" }));
    open();
    expect(await screen.findByAltText("The dashboard Splits Overview")).toBeInTheDocument();
    expect(screen.queryByTestId("tableau-viz")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("not a link to a view");
  });
});

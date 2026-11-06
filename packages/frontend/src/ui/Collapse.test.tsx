import React from "react";
import { fireEvent, render, screen } from "../testing.cjs";
import { Collapse } from "./Collapse";

test("opening a Collapse inside a form does not submit the form", () => {
  let submitted = 0;
  render(
    <form onSubmit={(e) => { e.preventDefault(); submitted += 1; }}>
      <Collapse items={[{ key: "detail", label: "Connection Details", children: <div>stage lines</div> }]} />
    </form>,
  );
  const header = screen.getByRole("button", { name: /Connection Details/ });
  expect(header.getAttribute("type")).toBe("button");
  fireEvent.click(header);
  expect(screen.getByText("stage lines")).toBeTruthy();
  expect(submitted).toBe(0);
});

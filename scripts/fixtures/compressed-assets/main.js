import "./style.css";

document.querySelector("button").addEventListener("click", async () => {
  const { detail } = await import("./detail.js");
  document.querySelector("output").textContent = detail;
});

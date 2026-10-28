const toast = document.querySelector(".toast");
document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    toast.textContent = `Đã sao chép ${button.dataset.copy}`;
  } catch {
    toast.textContent = "Không thể sao chép — hãy chọn và sao chép thủ công.";
  }
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1800);
}));

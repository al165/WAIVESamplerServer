const undoBtn = document.getElementById("undo-button");
if (undoBtn) {
    undoBtn.addEventListener('click', () => {
        fetch("/undo")
            .then(res => {
                if (res.ok)
                    location.reload(true);
            })
            .catch(err => console.error(err));
    });
}
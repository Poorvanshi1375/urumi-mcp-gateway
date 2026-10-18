# Local workflow on k3d. The VPS uses the same charts with values-prod.yaml (infra/scripts/deploy-ec2.sh).
#   make up         cluster + Secrets + images + both charts (safe to rerun)
#   make verify     definition-of-done checks against the running cluster, plus secret scans
#   make down       uninstall both releases; Secrets and volumes are kept, so `make up` brings the data back
#   make destroy    delete the k3d cluster and everything in it
# Options: GEMINI_KEY_FILE=<file> for `make secrets`; NS (default urumi).
SHELL := bash
.SHELLFLAGS := -euo pipefail -c
.ONESHELL:
NS ?= urumi
CLUSTER ?= urumi-local
# Passed to cluster-up.sh and to the image import (k3d-import.sh), so `make CLUSTER=x up` uses cluster x throughout.
export CLUSTER NS
STORE_VALUES := infra/helm/urumi-store/values-local.yaml
PLATFORM_VALUES := infra/helm/urumi-platform/values-local.yaml

.PHONY: up cluster secrets images install install-store install-platform verify verify-quick verify-all check-secrets hooks status down destroy

up: cluster secrets install

cluster:
	scripts/cluster-up.sh

secrets:
	NS=$(NS) scripts/secrets.sh $(if $(GEMINI_KEY_FILE),--gemini-key-file $(GEMINI_KEY_FILE))

# Builds the three images (tag = last commit of their sources) and imports them into the k3d nodes.
images:
	for s in platform woo-mcp ship-mcp; do echo "$$s: $$(infra/scripts/build-image.sh $$s | tail -1)"; done

install: install-store install-platform

install-store:
	helm upgrade --install store infra/helm/urumi-store -n $(NS) -f $(STORE_VALUES) --wait --timeout 15m

# The store must exist first: woo-mcp reads the Woo REST key from store-secrets and calls WordPress.
install-platform:
	PT=$$(infra/scripts/build-image.sh platform | tail -1)
	WT=$$(infra/scripts/build-image.sh woo-mcp | tail -1)
	ST=$$(infra/scripts/build-image.sh ship-mcp | tail -1)
	echo "images: platform $$PT, woo-mcp $$WT, ship-mcp $$ST"
	helm upgrade --install platform infra/helm/urumi-platform -n $(NS) -f $(PLATFORM_VALUES) \
	  --set image.tag=$$PT --set wooMcp.image.tag=$$WT --set shipMcp.image.tag=$$ST --wait --timeout 10m

verify: check-secrets
	scripts/verify-dod.sh

verify-quick:
	scripts/verify-dod.sh --quick

verify-all: check-secrets
	scripts/verify-dod.sh --all

check-secrets:
	scripts/check-secrets.sh --tree --live
	scripts/check-secrets.sh --history --live

hooks:
	git config core.hooksPath .githooks
	echo "pre-commit secret check enabled"

status:
	helm list -n $(NS)
	kubectl get pods,pvc,ingress -n $(NS)

down:
	helm uninstall platform -n $(NS) --wait || true
	helm uninstall store -n $(NS) --wait || true
	echo "releases removed; Secrets and volumes kept (kubectl get secret,pvc -n $(NS))"

destroy:
	read -r -p "Delete k3d cluster $(CLUSTER) and all its data? Type the cluster name: " a; [ "$$a" = "$(CLUSTER)" ]
	k3d cluster delete $(CLUSTER)

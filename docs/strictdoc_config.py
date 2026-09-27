from strictdoc.core.project_config import ProjectConfig


def create_config() -> ProjectConfig:
    return ProjectConfig(
        project_title="Responses API Compatibility Proxy",
        project_features=["TABLE_SCREEN", "TRACEABILITY_SCREEN", "SEARCH"],
        include_doc_paths=["project_memory/**", "handbook/**"],
    )
